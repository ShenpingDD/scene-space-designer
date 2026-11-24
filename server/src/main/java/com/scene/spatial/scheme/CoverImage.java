package com.scene.spatial.scheme;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;

/**
 * CoverImage —— 方案封面（浏览器截的那张三维视角 PNG）的**验收 + 落盘**（R6-3 3f）
 *
 * ## 为什么封面要"验收"，而不是收到就存
 *
 * 这不是上传一个文件，是**浏览器把画布内容编成字符串发过来**。所以它可能是：
 * 空字符串、被截断的 base64、`data:image/jpeg`（截图库换了默认）、一张 1×1 的空图、
 * 或者一张 4000×3000 的巨图。这些**必须在落盘前挡住**，否则：
 *   ＊ 存了非 PNG → 卡片上是个破图，而库里声称"有封面"（**假角标**，本项目最不能忍的那类）；
 *   ＊ 存了巨图 → 列表页每张卡片拖几 MB，而没人知道为什么慢。
 *
 * 拒的时候要说清**是哪一条不满足**（"格式错误"是没用的错误信息）——
 * 因为唯一能看到这条消息的人是正在改前端的人。
 *
 * ## 为什么文件名固定、而 md5 只进库
 *
 * 用户拍板（2026-09-29）：**封面不跟版本走，文件名始终一个，新的覆盖旧的**。
 * 代价是 URL 不变 → 浏览器可能给你看缓存里的旧图。`scheme.cover_checksum`
 * 这一列（`V9` 建的时候就写着「改了封面必须变 → 前端缓存键」）就是为这一刻准备的：
 * 文件名固定，但**内容指纹进库**，前端拿它当 `?v=`，于是"图变了"浏览器一定知道。
 *
 * 注意它要的是 **md5（CHAR(32)）**，不是 `Uploads` 那个 sha256 —— 列宽是 32，
 * 换算法就是换列，而 `V9` 已应用、不许改。
 */
public final class CoverImage {

  /** 上限 2 MB。1600×1200 的三维截图通常在 300–800 KB，够用且不至于让列表变重。 */
  public static final int MAX_BYTES = 2 * 1024 * 1024;

  /** 边长下限：比 64 小的一定不是一次真截图（1×1 那种"空捕获"要挡掉）。 */
  public static final int MIN_SIDE = 64;

  /** 边长上限：画布逻辑尺寸 × DPR 的正常量级是 1600–3200，4096 足够宽。 */
  public static final int MAX_SIDE = 4096;

  private static final String PREFIX = "data:image/png;base64,";

  /** PNG 文件头 8 字节：89 50 4E 47 0D 0A 1A 0A */
  private static final byte[] PNG_MAGIC = {
      (byte) 0x89, 'P', 'N', 'G', (byte) 0x0D, (byte) 0x0A, (byte) 0x1A, (byte) 0x0A
  };

  private CoverImage() {}

  /**
   * 解码并验收一张封面。
   *
   * @param bytes 原始 PNG 字节
   * @param width /height 从 IHDR 读出来的真实像素尺寸（不是客户端声称的）
   * @param md5   内容指纹（小写 32 位）—— 就是前面说的那个前端缓存键
   */
  public record Decoded(byte[] bytes, int width, int height, String md5) {}

  /** 读出来的一张封面：给接口层当响应体，指纹当 ETag。 */
  public record Cover(byte[] bytes, String md5) {}

  /**
   * 把 `data:image/png;base64,...` 解成字节并逐条验收。
   *
   * 任何一条不满足都抛 {@link IllegalArgumentException}，理由**具体到能照着改**。
   */
  public static Decoded decode(String dataUrl) {
    return decode(dataUrl, "封面");
  }

  /**
   * 带**称呼**的同一套校验。
   *
   * 加这个重载，是因为交付包里的三张三维截图也走这里（同一块画布、同样的尺寸上限）——
   * 而它们失败时如果回一句「封面太大」，用户会去翻封面，找不到问题在哪（R6-5 / A13）。
   */
  public static Decoded decode(String dataUrl, String what) {
    final String s = dataUrl == null ? "" : dataUrl.trim();
    if (s.isEmpty()) {
      throw new IllegalArgumentException("没有收到" + what + "数据（dataUrl 是空的）");
    }
    if (!s.startsWith(PREFIX)) {
      // 只提示前 40 字：整串 base64 有几百 KB，打进日志会把别的东西挤没
      throw new IllegalArgumentException(
          what + "只收 PNG 的 dataURL（要以 " + PREFIX + " 开头，收到：" + head(s) + "）");
    }

    final byte[] bytes;
    try {
      bytes = Base64.getDecoder().decode(s.substring(PREFIX.length()));
    } catch (IllegalArgumentException e) {
      throw new IllegalArgumentException(what + " base64 解不开："
          + (e.getMessage() == null ? "格式不对" : e.getMessage()));
    }

    validate(bytes, what);
    final int[] size = readIhdrSize(bytes, true);
    return new Decoded(bytes, size[0], size[1], md5(bytes));
  }

  /** 对已经在磁盘上的封面做同一套校验（读回来的时候还要用）。 */
  public static void validate(byte[] bytes) {
    validate(bytes, "封面");
  }

  public static void validate(byte[] bytes, String what) {
    if (bytes == null || bytes.length == 0) {
      throw new IllegalArgumentException(what + "是空的（0 字节）");
    }
    if (bytes.length > MAX_BYTES) {
      throw new IllegalArgumentException(what + "太大：" + bytes.length + " 字节，上限 "
          + MAX_BYTES + "（把画布缩小一点再截，或检查是不是把整页截进来了）");
    }
    if (bytes.length < PNG_MAGIC.length || !startsWithPng(bytes)) {
      throw new IllegalArgumentException("这不是 PNG（文件头不是 89504E470D0A1A0A）");
    }
    readIhdrSize(bytes, true);
  }

  /**
   * 从 IHDR 读宽高。
   *
   * 为什么值得**手解**这 8 个字节：PNG 的 IHDR 一定在文件头之后固定的位置
   * （偏移 8 = 长度，12 = "IHDR"，16 = 宽，20 = 高，都是大端 4 字节），
   * 而引入一个图片库只为读两个 int 是划算度很低的依赖。
   */
  private static int[] readIhdrSize(byte[] b, boolean checkRange) {
    if (b.length < 24
        || b[12] != 'I' || b[13] != 'H' || b[14] != 'D' || b[15] != 'R') {
      throw new IllegalArgumentException("PNG 里找不到 IHDR（文件可能被截断了），读不出尺寸");
    }
    final int w = beInt(b, 16);
    final int h = beInt(b, 20);
    if (checkRange && (w < MIN_SIDE || h < MIN_SIDE || w > MAX_SIDE || h > MAX_SIDE)) {
      throw new IllegalArgumentException("封面尺寸不合常理：" + w + "×" + h
          + "（每边应当在 " + MIN_SIDE + "–" + MAX_SIDE + " 之间）");
    }
    return new int[] {w, h};
  }

  private static int beInt(byte[] b, int at) {
    return ((b[at] & 0xFF) << 24) | ((b[at + 1] & 0xFF) << 16)
        | ((b[at + 2] & 0xFF) << 8) | (b[at + 3] & 0xFF);
  }

  private static boolean startsWithPng(byte[] b) {
    for (int i = 0; i < PNG_MAGIC.length; i++) {
      if (b[i] != PNG_MAGIC[i]) {
        return false;
      }
    }
    return true;
  }

  private static String head(String s) {
    return s.length() <= 40 ? s : s.substring(0, 40) + "…";
  }

  /** 小写 32 位 md5 —— 与 `scheme.cover_checksum CHAR(32)` 对齐。 */
  public static String md5(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(bytes));
    } catch (Exception e) {
      throw new IllegalStateException("算不出 md5（这不该发生）", e);
    }
  }

  /** 固定名：`<方案 id>.png`。**一次方案一张图，新的覆盖旧的**（用户拍板）。 */
  public static Path fileOf(Path dir, long schemeId) {
    return dir.resolve(schemeId + ".png").normalize();
  }

  /**
   * 落盘。**先写临时文件再原子改名** —— 与 `Uploads.store` 同一条理由：
   * 半截 PNG 也是"能解码的 PNG"（IHDR 在最前面），下发给浏览器就是一张破图。
   */
  public static Path store(Path dir, long schemeId, byte[] bytes) throws IOException {
    Files.createDirectories(dir);
    final Path target = fileOf(dir, schemeId);
    final Path tmp = Files.createTempFile(dir, ".cover-", ".part");
    try {
      Files.write(tmp, bytes, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING);
      try {
        Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING);
      } catch (AtomicMoveNotSupportedException e) {
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
      }
    } finally {
      Files.deleteIfExists(tmp);
    }
    return target;
  }
}