package com.scene.spatial.params;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * ParamsFingerprintTest —— 参数指纹（R6-4 B4a）
 *
 * 钉「**同一个配置，两边算出一个数**」：方案落库时是 Java 写 `params_rev`，
 * 而前端与内核的缓存键用 JS 侧 `fingerprint()`；两边不一致 = 同一个配置有两个指纹。
 * 这种错**不会报错** —— 只会让缓存莫名失效、「同一份方案复现不出来」，所以必须钉住字面量。
 *
 * 另一个要钉的是**旧实现答不出的那个问题**：改一个生效值，指纹必须变。
 * 改之前 `Params.fingerprint()` 的输入是 `path=默认值`，所以它做不到这件事 —— 那正是要改的原因。
 */
class ParamsFingerprintTest {

  /** 默认配置的指纹。**两边抄同一个数**：JS 侧 spatial-core/test/params.test.js */
  private static final int DEFAULTS_FINGERPRINT = 1831018939;

  @Test
  @DisplayName("默认参数表的指纹 = 1831018939（与 JS 侧同一个数）")
  void defaultsArePinned() {
    assertEquals(DEFAULTS_FINGERPRINT, ParamsFingerprint.defaults());
    assertEquals(DEFAULTS_FINGERPRINT, ParamsFingerprint.of(null));
    assertEquals(DEFAULTS_FINGERPRINT, ParamsFingerprint.of(Map.of()));
  }

  @Test
  @DisplayName("改一个生效值 → 指纹就变（按默认值算的旧实现做不到这件事）")
  void followsEffectiveValues() {
    final Map<String, Object> v = new LinkedHashMap<>();
    v.put("door.openOkDeg", 85);
    assertNotEquals(DEFAULTS_FINGERPRINT, ParamsFingerprint.of(v));

    v.put("door.openOkDeg", 90);
    assertEquals(DEFAULTS_FINGERPRINT, ParamsFingerprint.of(v), "改回原值应当回到同一个指纹");
  }

  @Test
  @DisplayName("整数不能写成 3.0（JS 的 String(3) 是「3」）")
  void integersAreWrittenWithoutDecimal() {
    assertEquals("3", ParamsFingerprint.canonicalValue(3));
    assertEquals("3", ParamsFingerprint.canonicalValue(3.0));
    assertEquals("3", ParamsFingerprint.canonicalValue(3L));
    assertEquals("1000000", ParamsFingerprint.canonicalValue(1000000));
    assertEquals("0.005", ParamsFingerprint.canonicalValue(0.005));
    assertEquals("0.5", ParamsFingerprint.canonicalValue(0.50));
    assertEquals("0.1", ParamsFingerprint.canonicalValue(new java.math.BigDecimal("0.10")));
    assertEquals("true", ParamsFingerprint.canonicalValue(Boolean.TRUE));
    assertEquals("global", ParamsFingerprint.canonicalValue("global"));
  }

  @Test
  @DisplayName("指纹只由值决定：与 map 的插入顺序无关")
  void orderIndependent() {
    final Map<String, Object> a = new LinkedHashMap<>();
    a.put("room.maxW", 22);
    a.put("door.openOkDeg", 85);
    final Map<String, Object> b = new LinkedHashMap<>();
    b.put("door.openOkDeg", 85);
    b.put("room.maxW", 22);
    assertEquals(ParamsFingerprint.of(a), ParamsFingerprint.of(b));
  }
}
