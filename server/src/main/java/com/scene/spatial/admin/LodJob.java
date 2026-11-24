package com.scene.spatial.admin;

import com.scene.spatial.kernel.Json;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * LodJob —— 把刚上传的原始模型做成三级 LOD（R6-2）
 *
 * 为什么后端要调外部进程：LOD 生成是 three.js + meshopt 的活儿，而**这个能力已经存在**
 * （就是前台用的同一个优化器）。在 Java 侧再造一套几何代码，是迟早要打架的第二套真相。
 * 所以后端只负责三件事：把命令行拼对、把结果读回来、把状态改对。
 *
 * ⚠️ 三条不含糊的规矩：
 *  ① **可选**：spatial.lod.enabled=false 时明确返回「被配置关掉了」，而不是静默不跑。
 *  ② **node 不在就停 draft**，并把原因写进库里。悄悄没优化与优化过了，在界面上太像了 ——
 *     这类相似性都要消灭。
 *  ③ **不拿事务包住跑进程**：一个跑几十秒的子进程绝不该占着数据库连接。
 */
@Component
public class LodJob {

  /**
   * @param ok          作业本身是否成功（不代表产品一定达标）
   * @param reason      失败原因（ok=true 时为 null）—— 这句话会**原样写进库里**给人看
   * @param levelsJson  落 lod_json 的内容：{levels, skipped, manifest}
   * @param entryFile   默认加载的那一级产物（相对路径，与存量同形）
   */
  public record Result(boolean ok, String reason, String levelsJson,
                       String entryFile, int entryBytes, int levelCount, int skippedCount) {

    static Result failed(String why) { return new Result(false, why, null, null, 0, 0, 0); }
  }

  private final boolean enabled;
  private final String nodeCmd;
  private final Path script;
  private final Path outDir;
  /** 与 outDir 同一个目录，但保持**相对形式** —— 存进库的路径要与存量产品同形。配置请用正斜杠。 */
  private final String outDirRel;
  private final Path logFile;

  public LodJob(@Value("${spatial.lod.enabled:true}") boolean enabled,
                @Value("${spatial.lod.node:node}") String nodeCmd,
                @Value("${spatial.lod.script:tools/models/optimize-models.mjs}") String script,
                @Value("${spatial.lod.out-dir:assets/optimized}") String outDir,
                @Value("${spatial.lod.log:logs/lod-job.log}") String log) {
    this.enabled = enabled;
    this.nodeCmd = nodeCmd;
    this.script = Paths.get(script).toAbsolutePath().normalize();
    this.outDir = Paths.get(outDir).toAbsolutePath().normalize();
    this.outDirRel = outDir.replaceAll("/+$", "");
    this.logFile = Paths.get(log).toAbsolutePath().normalize();
  }

  public boolean enabled() { return enabled; }

  /** 阻塞执行（几秒到几十秒）。**调用方必须放到后台线程** —— 绝不在请求线程里跑。 */
  public Result run(String assetId, Path sourceFile) {
    if (!enabled) return Result.failed("LOD 作业被配置关掉了（spatial.lod.enabled=false）");
    if (!Files.isRegularFile(sourceFile)) return Result.failed("源模型不在：" + sourceFile);
    if (!Files.isRegularFile(script)) return Result.failed("优化器脚本不在：" + script);
    final String nodeVer = nodeVersion();
    if (nodeVer == null) {
      return Result.failed("本机跑不了 node（命令 " + nodeCmd + " 不可用）—— 产品停在 draft，"
          + "可由人在维护端手动重跑，或把 LOD 与服务分到两台机器上");
    }

    Path json = null;
    try {
      Files.createDirectories(outDir);
      json = Files.createTempFile(outDir, ".lodjob-", ".json");
      final List<String> cmd = List.of(nodeCmd, script.toString(), "--only", sourceFile.toString(),
          "--asset-id", assetId, "--out", outDir.toString(), "--json", json.toString());
      // 优化器按**仓库根**的相对路径写产物（assets/optimized/...），所以工作目录必须是根
      final ProcessBuilder pb = new ProcessBuilder(cmd)
          .directory(script.getParent().getParent().getParent().toFile());
      pb.redirectErrorStream(true);
      // 输出**重定向到文件**而不是管道：管道没人读会被写满，子进程就卡死在那儿了
      // （那种「刚才还好好的、突然就不动了」最难查）。日志留着也是证据。
      Files.createDirectories(logFile.getParent());
      pb.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile.toFile()));

      final Process proc = pb.start();
      if (!proc.waitFor(20, TimeUnit.MINUTES)) {
        proc.destroyForcibly();
        return Result.failed("LOD 作业超时（20 分钟）—— 日志见 " + logFile);
      }
      if (proc.exitValue() != 0) {
        return Result.failed("优化器退出码 " + proc.exitValue() + "（node " + nodeVer + "）—— 日志见 " + logFile);
      }
      return read(assetId, sourceFile, json);
    } catch (Exception e) {
      return Result.failed("LOD 作业出错：" + e.getClass().getSimpleName() + " " + e.getMessage());
    } finally {
      if (json != null) {
        try { Files.deleteIfExists(json); } catch (Exception ignore) { /* 临时文件删不掉不该影响结论 */ }
      }
    }
  }

  private Result read(String assetId, Path sourceFile, Path json) throws Exception {
    final Map<String, Object> m = asMap(Json.parse(Files.readString(json, StandardCharsets.UTF_8)));
    final List<Object> lods = asList(m.get("lods"));
    if (lods.isEmpty()) return Result.failed("优化器没产出任何一级 LOD（assetId=" + assetId + "）");

    final String md5 = md5Of(sourceFile);   // md5 是**源级**的：三级共用同一个值（与存量一致）
    final List<Object> levels = new ArrayList<>();
    final List<Object> skipped = new ArrayList<>();
    String entryFile = null;
    int entryBytes = 0;
    for (final Object o : lods) {
      final Map<String, Object> l = asMap(o);
      if (Boolean.TRUE.equals(l.get("skipped"))) {
        skipped.add(Json.obj("level", l.get("level"), "equivalentTo", l.get("equivalentTo"),
            "triangles", l.get("triangles"), "reason", "与该级预算等效，刻意跳过"));
        continue;
      }
      final Map<String, Object> e = new LinkedHashMap<>();
      e.put("md5", md5);
      // 优化器只给**文件名**（它的注释写着：调用方知道 outDir，拼了反而两处会走样）——
      // 所以这里由我们拼，存的形状与存量一致：assets/optimized/<assetId>.<level>.glb
      e.put("file", outDirRel + "/" + str(l.get("file")));
      e.put("bytes", l.get("bytes"));
      e.put("triangles", l.get("triangles"));
      // 刻意不放 bboxMm / textures：优化器不产这两个数，编一个出来比缺了更坏。
      // 真值在 product_model 的 bbox_* 列（浏览器量出来的）。
      levels.add(e);
      if (entryFile == null) {
        entryFile = outDirRel + "/" + str(l.get("file"));
        entryBytes = num(l.get("bytes"));
      }
    }
    if (entryFile == null || entryFile.isEmpty()) {
      return Result.failed("优化器报了成功，却没有可加载的产物路径（assetId=" + assetId + "）");
    }
    final String levelsJson = Json.write(Json.obj("levels", levels, "skipped", skipped,
        "manifest", "未并入 lod.manifest.json（单件模式刻意不动它，免得动到存量产品的引用）"), 0);
    return new Result(true, null, levelsJson, entryFile, entryBytes, levels.size(), skipped.size());
  }

  /** 探测 node：拿不到版本号就当它不在。**不抛异常**，失败是一种正常答案。 */
  private String nodeVersion() {
    try {
      final ProcessBuilder pb = new ProcessBuilder(nodeCmd, "--version").redirectErrorStream(true);
      final Process p = pb.start();
      final String v = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).strip();
      if (!p.waitFor(20, TimeUnit.SECONDS)) { p.destroyForcibly(); return null; }
      return p.exitValue() == 0 && !v.isEmpty() ? v : null;
    } catch (Exception e) {
      return null;
    }
  }

  static String md5Of(Path f) throws Exception {
    final MessageDigest md = MessageDigest.getInstance("MD5");
    md.update(Files.readAllBytes(f));
    return HexFormat.of().formatHex(md.digest());
  }

  static Map<String, Object> asMap(Object o) {
    if (!(o instanceof Map)) return new LinkedHashMap<>();
    final Map<String, Object> out = new LinkedHashMap<>();
    for (final Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
      out.put(String.valueOf(e.getKey()), e.getValue());
    }
    return out;
  }

  static List<Object> asList(Object o) {
    return o instanceof List ? new ArrayList<>((List<?>) o) : new ArrayList<>();
  }

  private static String str(Object o) { return o == null ? "" : String.valueOf(o); }

  private static int num(Object o) {
    if (o instanceof Number n) return n.intValue();
    try { return o == null ? 0 : Integer.parseInt(String.valueOf(o)); } catch (NumberFormatException e) { return 0; }
  }
}
