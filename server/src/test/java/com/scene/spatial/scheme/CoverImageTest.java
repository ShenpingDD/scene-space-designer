package com.scene.spatial.scheme;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CoverImageTest —— 封面验收的**每一条判据**（R6-3 3f）
 *
 * ## 这个测试钉的是什么
 *
 * 钉的是「**什么会被拒，以及拒的时候说了什么**」。理由很实在：封面是浏览器把画布
 * 编成字符串发过来的，所以它可能是空串、被截断的 base64、JPEG、1×1 的空捕获、
 * 或者一张巨图 —— 而这些**必须在落盘前挡住**。放进库的代价是卡片上永远挂着一张破图，
 * 而库里声称"有封面"（**假角标**，本项目最不能忍的那类）。
 *
 * ## 一个必须说清的局限
 *
 * `CoverImage` **不做全量解码**：它验的是「确实是 PNG、尺寸合常理、大小可控」，
 * **不验** IDAT 里的像素能不能解出图。所以这个测试里的"合法样本"也只是
 * **一个够真的文件头**（40 字节），不是一张能看的图 ——
 * 把判据说清楚，胜过说一句做不到的"校验通过"。
 *
 * ## 为什么要钉 md5 字面量
 *
 * `cover_checksum` 同时是前端 `?v=` 与下发接口的 ETag。它**必须跟着内容变**，
 * 所以测试要验"同一份字节 → 同一个值""不同字节 → 不同的值"，而且值**写死**在测试里 ——
 * 现算一遍再比，等于把"实现和测试一起改错"这条路留着。
 */
class CoverImageTest {

  /** 合法样本（1600×1200 的 PNG 头，40 字节）的 md5 —— 用别的方式算出来钉在这儿的 */
  private static final String MD5_1600x1200 = "f3d66ce61642864c1c07e35c670337c7";

  @Test
  @DisplayName("收下合法的一张：尺寸从 IHDR 读出来，指纹是内容 md5")
  void acceptsValidPng() {
    final byte[] png = pngHeader(1600, 1200);
    final CoverImage.Decoded d = CoverImage.decode(dataUrl(png));

    assertEquals(40, d.bytes().length, "字节原样收下（不是重新编码过的）");
    assertEquals(1600, d.width(), "宽从 IHDR 读出来（不是客户端声称的）");
    assertEquals(1200, d.height(), "高从 IHDR 读出来");
    assertEquals(MD5_1600x1200, d.md5(), "指纹是内容 md5（32 位小写），钉死在这里");
    assertEquals(32, d.md5().length(), "长度 32 —— 与 scheme.cover_checksum CHAR(32) 对齐");
    assertEquals(d.md5(), d.md5().toLowerCase(), "小写（大写会让前端的 ?v= 与库里的值看着不一样）");
  }

  @Test
  @DisplayName("内容变一个字节 → 指纹必须变（它不变，用户就一直看缓存里的旧图）")
  void checksumFollowsContent() {
    final byte[] a = pngHeader(1600, 1200);
    final byte[] b = pngHeader(1600, 1200);
    b[24] = 8;                                  // 只改一个字节

    assertEquals(MD5_1600x1200, CoverImage.md5(a), "没改的那份还是老指纹");
    assertEquals("43d20eca456d8e412d650a043d049c61", CoverImage.md5(b), "改一字节后的指纹（钉死）");
    assertNotEquals(CoverImage.md5(a), CoverImage.md5(b),
        "**同一个文件名、不同内容，指纹必须不同** —— 否则「图变了」浏览器不知道");
  }

  @Test
  @DisplayName("空 / 没有 PNG 头 / base64 坏 / 不是 PNG：四种都要拒，而且理由各不一样")
  void rejectsGarbage() {
    assertEquals("没有收到封面数据（dataUrl 是空的）",
        reason(() -> CoverImage.decode(null)), "null 的理由");
    assertEquals("没有收到封面数据（dataUrl 是空的）",
        reason(() -> CoverImage.decode("   ")), "空白串的理由");

    final String wrongType = reason(() -> CoverImage.decode("data:image/jpeg;base64,AAAA"));
    assertTrue(wrongType.contains("data:image/png;base64,"),
        "换了图片格式的理由里要说清**要哪一种**，收到：" + wrongType);

    final String badB64 = reason(() -> CoverImage.decode("data:image/png;base64,!!!!"));
    assertTrue(badB64.startsWith("封面 base64 解不开"), "base64 坏掉的理由：" + badB64);

    // 这是最容易发生的一种：字节不是 PNG（比如把 HTML 错误页当图片存了）
    final String notPng = reason(() -> CoverImage.decode(dataUrl("hello, world!".getBytes())));
    assertTrue(notPng.contains("89504E470D0A1A0A"),
        "不是 PNG 时要把**文件头判据**说出来：" + notPng);
  }

  @Test
  @DisplayName("截断的 PNG：读不出 IHDR 就拒，不硬猜尺寸")
  void rejectsTruncated() {
    final byte[] full = pngHeader(1600, 1200);
    final byte[] cut = new byte[14];                       // 只留下魔数 + "IHDR" 这几个字节
    System.arraycopy(full, 0, cut, 0, 14);

    final String m = reason(() -> CoverImage.decode(dataUrl(cut)));
    assertTrue(m.contains("IHDR"), "截断的理由要指向 IHDR：" + m);
  }

  @Test
  @DisplayName("尺寸不合常理要拒：1×1（空捕获）与 5000 宽（巨图）都不是一次真截图")
  void rejectsAbsurdSizes() {
    final String tiny = reason(() -> CoverImage.decode(dataUrl(pngHeader(1, 1))));
    assertTrue(tiny.contains("1×1"), "要报出真实的尺寸：" + tiny);
    assertTrue(tiny.contains("64"), "也要报出边界，改的人才知道该调到多少：" + tiny);

    final String huge = reason(() -> CoverImage.decode(dataUrl(pngHeader(5000, 1200))));
    assertTrue(huge.contains("5000×1200"), "要报出真实的尺寸：" + huge);
  }

  @Test
  @DisplayName("超过 2 MB 要拒（列表页每张卡拖几 MB，而没人知道为什么慢）")
  void rejectsTooLarge() {
    final byte[] big = new byte[CoverImage.MAX_BYTES + 1];
    System.arraycopy(pngHeader(1600, 1200), 0, big, 0, 24);

    final String m = reason(() -> CoverImage.decode(dataUrl(big)));
    assertTrue(m.contains(String.valueOf(CoverImage.MAX_BYTES)), "要报出上限：" + m);
    assertEquals(CoverImage.MAX_BYTES, 2 * 1024 * 1024, "上限就是 2 MB（常量本身也钉一下）");

    // 边界：刚好等于上限要能收（别写成 ">= 就拒"）
    final byte[] exact = new byte[CoverImage.MAX_BYTES];
    System.arraycopy(pngHeader(1600, 1200), 0, exact, 0, 24);
    assertEquals(CoverImage.MAX_BYTES, CoverImage.decode(dataUrl(exact)).bytes().length,
        "刚好 2 MB 是收下的（上限是闭区间）");
  }

  @Test
  @DisplayName("落盘：文件名固定为 <id>.png，新的覆盖旧的，且不留 .part 垃圾")
  void storesWithFixedNameAndOverwrites(@TempDir Path dir) throws Exception {
    assertEquals(dir.resolve("7.png"), CoverImage.fileOf(dir, 7L), "文件名就是 <方案 id>.png（固定名）");

    final byte[] first = pngHeader(1600, 1200);
    final Path p = CoverImage.store(dir, 7L, first);
    assertEquals(dir.resolve("7.png"), p, "存到哪就说哪");
    assertEquals(40, Files.size(p), "内容写进去了");
    assertArrayEqualsExactly(first, Files.readAllBytes(p), "字节没被改过");

    final byte[] second = pngHeader(800, 600);
    CoverImage.store(dir, 7L, second);
    assertEquals(40, Files.size(dir.resolve("7.png")), "**新的盖旧的**：还是那一个文件");
    assertArrayEqualsExactly(second, Files.readAllBytes(dir.resolve("7.png")), "内容换成了新的");
    assertEquals(1, Files.list(dir).filter(f -> f.getFileName().toString().endsWith(".png")).count(),
        "目录里同一份方案只有一张图（这就是「不跟版本走」的样子）");
    assertEquals(0, Files.list(dir).filter(f -> f.getFileName().toString().endsWith(".part")).count(),
        "临时文件必须清干净（半截 PNG 也是「能解码的 PNG」，发出去就是破图）");
  }

  @Test
  @DisplayName("别的方案互不干扰：id 不同 → 文件不同（固定名是按方案各自的）")
  void separateIdsDoNotCollide(@TempDir Path dir) throws Exception {
    CoverImage.store(dir, 7L, pngHeader(1600, 1200));
    CoverImage.store(dir, 8L, pngHeader(800, 600));

    assertTrue(Files.isRegularFile(dir.resolve("7.png")), "7 号那张还在");
    assertTrue(Files.isRegularFile(dir.resolve("8.png")), "8 号的另存一张");
    assertFalse(Files.isRegularFile(dir.resolve("7.png.part")), "7 号那张没被 8 号影响");
  }

  // ───────────────────────── 工具 ─────────────────────────

  /**
   * 造一个"够真"的 PNG 文件头：8 字节魔数 + IHDR 长度 + "IHDR" + 宽 + 高。
   *
   * 这就是这个测试能造出的**最像真图**的东西 —— `CoverImage` 只验到这一步（见类注释的局限说明）。
   * 宽高按大端写，与 PNG 规范一致。
   */
  private static byte[] pngHeader(int w, int h) {
    final byte[] b = new byte[40];
    final byte[] magic = {(byte) 0x89, 'P', 'N', 'G', (byte) 0x0D, (byte) 0x0A, (byte) 0x1A, (byte) 0x0A};
    System.arraycopy(magic, 0, b, 0, magic.length);
    b[8] = 0; b[9] = 0; b[10] = 0; b[11] = 13;      // IHDR 数据长度 = 13
    b[12] = 'I'; b[13] = 'H'; b[14] = 'D'; b[15] = 'R';
    b[16] = (byte) (w >>> 24); b[17] = (byte) (w >>> 16); b[18] = (byte) (w >>> 8); b[19] = (byte) w;
    b[20] = (byte) (h >>> 24); b[21] = (byte) (h >>> 16); b[22] = (byte) (h >>> 8); b[23] = (byte) h;
    return b;
  }

  private static String dataUrl(byte[] bytes) {
    return "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes);
  }

  /** 取"被拒的理由"。断言理由本身，而不是只断言"抛了异常" —— 理由才是给改的人看的东西 */
  private static String reason(Runnable r) {
    return assertThrows(IllegalArgumentException.class, r::run).getMessage();
  }

  private static void assertArrayEqualsExactly(byte[] want, byte[] got, String msg) {
    assertEquals(want.length, got.length, msg);
    for (int i = 0; i < want.length; i++) {
      if (want[i] != got[i]) throw new AssertionError(msg + "：第 " + i + " 个字节不一样");
    }
  }
}