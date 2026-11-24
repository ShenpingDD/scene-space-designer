package com.scene.spatial.admin;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Locale;

/**
 * Uploads —— 上传件的落盘（R6-2）
 *
 * 两条规矩，都是为了"出了事能查"：
 *   ① **内容寻址**：文件名 = 内容 SHA-256。同一个模型重复上传不产生第二份，
 *      而且 URL 天然不可变 —— 所以 /api/assets 敢给 immutable 长缓存。
 *   ② **先写临时文件再原子改名**：半截文件永远不可能被下发出去
 *      （上传大文件时进程被 kill，在 Windows 上不是罕见事）。
 *
 * 名字校验**不靠 Path.normalize 就算完**：GLB 之外一律不收 ——
 * "什么都能传"的代价是以后没人知道这个目录里该有什么。
 */
public final class Uploads {

  private Uploads() {}

  public static String sha256(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (Exception e) {
      throw new IllegalStateException("算不出 SHA-256（这不该发生）", e);
    }
  }

  /** 只收 GLB。返回原名（用于日志），并**当场说清**为什么拒 —— 不要只回"格式错误"。 */
  public static String checkGlbName(String original) {
    final String n = original == null ? "" : original.trim();
    if (n.isEmpty()) throw new IllegalArgumentException("文件没有名字");
    if (!n.toLowerCase(Locale.ROOT).endsWith(".glb")) {
      throw new IllegalArgumentException(
          "只收 .glb（收到：" + n + "）—— 请让供应商导出一份 GLB，不要混着传 FBX / ZIP");
    }
    return n;
  }

  /**
   * 缩略图扩展名白名单：只收 png/jpeg（按内容类型优先，退回原文件名）。
   * 返回落盘用的扩展名（`.png` / `.jpg`），不带点。
   */
  public static String checkThumbName(String original, String contentType) {
    final String ct = contentType == null ? "" : contentType.trim().toLowerCase(Locale.ROOT);
    if ("image/png".equals(ct)) return "png";
    if ("image/jpeg".equals(ct) || "image/jpg".equals(ct)) return "jpg";
    final String n = original == null ? "" : original.trim().toLowerCase(Locale.ROOT);
    if (n.endsWith(".png")) return "png";
    if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "jpg";
    throw new IllegalArgumentException("只收 PNG / JPEG 缩略图（收到：" + (original == null ? "(空)" : original)
        + "，类型：" + (ct.isEmpty() ? "(空)" : ct) + "）");
  }

  /** 缩略图落盘；文件名 = 内容 SHA-256 + 扩展名，内容相同直接复用。 */
  public static Path storeThumb(Path dir, byte[] bytes, String ext) throws IOException {
    final String sha = sha256(bytes);
    final Path target = dir.resolve(sha + "." + ext);
    if (Files.isRegularFile(target)) return target;
    Files.createDirectories(dir);
    final Path tmp = Files.createTempFile(dir, ".thumb-", ".part");
    try {
      Files.write(tmp, bytes, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING);
      try {
        Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
      } catch (AtomicMoveNotSupportedException e) {
        Files.move(tmp, target);
      }
    } finally {
      Files.deleteIfExists(tmp);
    }
    return target;
  }

  /** 落盘，返回最终路径。内容相同 → 直接复用已有文件，不写第二遍。 */
  public static Path store(Path dir, byte[] bytes) throws IOException {
    final String sha = sha256(bytes);
    final Path target = dir.resolve(sha + ".glb");
    if (Files.isRegularFile(target)) return target;
    Files.createDirectories(dir);
    final Path tmp = Files.createTempFile(dir, ".upload-", ".part");
    try {
      Files.write(tmp, bytes, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING);
      try {
        Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
      } catch (AtomicMoveNotSupportedException e) {
        Files.move(tmp, target);        // 退路：同盘 rename 本来就是原子的
      }
    } finally {
      Files.deleteIfExists(tmp);        // 失败也不留垃圾
    }
    return target;
  }
}
