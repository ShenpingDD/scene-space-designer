package com.scene.spatial.admin;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 验收-2 缩略图：扩展名白名单 + 内容寻址落盘。 */
class UploadsTest {

  @TempDir
  Path dir;

  @Test
  void onlyPngAndJpegAreAccepted() {
    assertEquals("png", Uploads.checkThumbName("a.png", "image/png"));
    assertEquals("jpg", Uploads.checkThumbName("a.jpeg", "image/jpeg"));
    assertEquals("png", Uploads.checkThumbName("a.PNG", null));
    assertThrows(IllegalArgumentException.class, () -> Uploads.checkThumbName("a.gif", "image/gif"));
    assertThrows(IllegalArgumentException.class, () -> Uploads.checkThumbName("a.glb", "model/gltf-binary"));
    assertThrows(IllegalArgumentException.class, () -> Uploads.checkThumbName(null, null));
  }

  @Test
  void thumbIsContentAddressedAndDeduped() throws Exception {
    final byte[] png = new byte[] {(byte) 0x89, 'P', 'N', 'G', 1, 2, 3};
    final Path a = Uploads.storeThumb(dir, png, "png");
    final Path b = Uploads.storeThumb(dir, png, "png");
    assertEquals(a, b, "同样内容必须复用同一份");
    assertTrue(Files.isRegularFile(a));
    assertTrue(a.getFileName().toString().endsWith(".png"));
    assertEquals(64 + 4, a.getFileName().toString().length(), "文件名应为 sha256 + .png");
    assertArrayEquals(png, Files.readAllBytes(a));
  }
}
