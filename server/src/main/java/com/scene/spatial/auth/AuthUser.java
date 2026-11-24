package com.scene.spatial.auth;

/**
 * 登录账号的身份（会话里带的那几个人事字段）
 *
 * 刻意**不带** `password_hash`：散列只在会话内部用来判断"口令是不是换过了"，
 * 它不进这个记录，也就不可能被谁顺手塞进响应体。
 */
public record AuthUser(long id, String username, String displayName, String roleCode, boolean enabled) {
}
