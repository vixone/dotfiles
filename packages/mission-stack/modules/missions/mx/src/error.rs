//! Exit codes: 0 ok, 1 not found or invalid, 2 usage, 3 secret refused.

use std::fmt;

#[derive(Debug)]
pub struct Exit {
    pub code: i32,
    pub msg: String,
}

impl fmt::Display for Exit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Exit {}

pub const INVALID: i32 = 1;
pub const USAGE: i32 = 2;
pub const SECRET: i32 = 3;

pub fn invalid(msg: impl Into<String>) -> anyhow::Error {
    Exit { code: INVALID, msg: msg.into() }.into()
}

pub fn usage(msg: impl Into<String>) -> anyhow::Error {
    Exit { code: USAGE, msg: msg.into() }.into()
}

pub fn secret(msg: impl Into<String>) -> anyhow::Error {
    Exit { code: SECRET, msg: msg.into() }.into()
}

pub fn not_found(id: &str) -> anyhow::Error {
    invalid(format!("issue {id} not found"))
}

/// Exit code for an error chain: the first [`Exit`] wins, anything else is 1.
pub fn code_of(err: &anyhow::Error) -> i32 {
    err.chain()
        .find_map(|e| e.downcast_ref::<Exit>())
        .map_or(INVALID, |e| e.code)
}
