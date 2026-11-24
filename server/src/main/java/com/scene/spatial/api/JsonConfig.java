package com.scene.spatial.api;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.ValueSerializer;
import tools.jackson.databind.module.SimpleModule;

/**
 * JsonConfig —— web 层的数字写法，与**内核自己的写法对齐**。
 *
 * 内核的 JSON 写入器（{@code kernel.Json.numText}）遇到整数值写 `8` 而不是 `8.0`，
 * 但 web 层走的是 Jackson，`double` 一律写成 `8.0`。于是同一个数在"内核说的"和"接口回的"
 * 里长得不一样：客户端送 `w: 8`，服务端回 `w: 8.0`。
 *
 * 这不只是好看问题 —— 方案的 state 会被**存进库**再取回来，同一个值两种写法会让
 * `rev` 比对、缓存键、人工看日志都多一层噪声。所以这里统一到内核那一套：
 * **整数值不带小数点**（边界与 numText 一致：`< 1e15`）。
 *
 * 注意这是 **Jackson 3** 的 API（Spring Boot 4 起默认 Jackson 3：包名是 `tools.jackson.*`，
 * 序列化器基类叫 `ValueSerializer`、上下文叫 `SerializationContext`）。
 * 用 Jackson 2 的 `com.fasterxml.jackson.databind.module.SimpleModule` 写是**不会生效的** ——
 * 它编译得过，但 Boot 4 的 MVC 根本不看那个类型的 bean（踩过一次，记在这）。
 */
@Configuration
public class JsonConfig {

  @Bean
  public SimpleModule wholeNumberDoubles() {
    final ValueSerializer<Double> ser = new ValueSerializer<>() {
      @Override
      public void serialize(Double v, JsonGenerator g, SerializationContext c) throws JacksonException {
        if (v == null) {
          g.writeNull();
        } else if (v == Math.rint(v) && Math.abs(v) < 1e15) {
          g.writeNumber(v.longValue());
        } else {
          g.writeNumber(v.doubleValue());
        }
      }
    };
    final SimpleModule m = new SimpleModule("xy-whole-doubles");
    m.addSerializer(Double.class, ser);
    m.addSerializer(double.class, ser);   // 基本类型也走同一条（double.class 的类型是 Class<Double>）
    return m;
  }
}
