//! Secret scan for every text field mx writes. Ported from SECRET_PATTERNS in
//! modules/missions/extensions/mission-stack/remember-gate.ts (same labels
//! and regexes, JS `/i` became `(?i)`).

use std::sync::OnceLock;

use anyhow::Result;
use regex::Regex;

use crate::error;

const PATTERNS: &[(&str, &str)] = &[
    ("AWS access key ID (AKIA…)", r"\bAKIA[0-9A-Z]{16}\b"),
    (
        "AWS access key (env-var assignment)",
        r#"(?i)\bAWS_(SECRET_)?(ACCESS_)?KEY(_ID)?\s*[=:]\s*['"]?[A-Za-z0-9/+=]{16,}['"]?"#,
    ),
    ("PEM private key block", r"-----BEGIN\s+([A-Z]+\s+)?PRIVATE\s+KEY-----"),
    ("GitHub personal access token (ghp_…)", r"\bghp_[A-Za-z0-9]{36}\b"),
    ("GitHub fine-grained PAT (github_pat_…)", r"\bgithub_pat_[A-Za-z0-9_]{82}\b"),
    ("Slack token (xox[abp]-…)", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    (
        "Bearer-style token (Authorization: Bearer …)",
        r"\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}={0,2}",
    ),
    (
        "Generic password-like assignment",
        r#"(?i)\b(password|passwd|secret|api[_-]?key)\s*[=:]\s*['"][^'"]{8,}['"]"#,
    ),
    (
        "JWT (eyJ… header)",
        r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b",
    ),
];

/// A match followed by a placeholder (`<YOUR_KEY>`, `$VAR`, `...`, `REDACTED`,
/// `***`) is documentation, not a secret.
const PLACEHOLDER_TAIL: &str = r"^(\s*[<$]|\s*\.\.\.|\s*REDACTED|\s*\*+|\s*\[REDACTED\])";

struct Compiled {
    patterns: Vec<(&'static str, Regex)>,
    placeholder: Regex,
}

fn compiled() -> &'static Compiled {
    static C: OnceLock<Compiled> = OnceLock::new();
    C.get_or_init(|| Compiled {
        patterns: PATTERNS
            .iter()
            .map(|(label, re)| (*label, Regex::new(re).expect("secret pattern compiles")))
            .collect(),
        placeholder: Regex::new(PLACEHOLDER_TAIL).expect("placeholder pattern compiles"),
    })
}

/// Label of the first secret found in `text`, if any.
pub fn scan(text: &str) -> Option<&'static str> {
    let c = compiled();
    for (label, re) in &c.patterns {
        for m in re.find_iter(text) {
            let tail: String = text[m.end()..].chars().take(16).collect();
            if !c.placeholder.is_match(&tail) {
                return Some(label);
            }
        }
    }
    None
}

/// Refuse (exit 3) if any `(field, text)` pair holds a secret. The secret
/// itself is never echoed.
pub fn check(fields: &[(&str, &str)]) -> Result<()> {
    for (field, text) in fields {
        if let Some(label) = scan(text) {
            return Err(error::secret(format!(
                "refusing to write: {label} found in {field}. Remove it or use a placeholder like <REDACTED>."
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::scan;

    #[test]
    fn detects_each_pattern() {
        let samples = [
            "AKIAABCDEFGHIJKLMNOP",
            "AWS_SECRET_ACCESS_KEY=abcdEFGHijklMNOPqrst1234",
            "-----BEGIN RSA PRIVATE KEY-----",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            &format!("github_pat_{}", "a".repeat(82)),
            "xoxb-1234567890-abcdef",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
            "password = 'hunter2hunter2'",
            "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f",
        ];
        for s in samples {
            assert!(scan(s).is_some(), "missed: {s}");
        }
    }

    #[test]
    fn placeholders_and_prose_pass() {
        for s in [
            "export AWS_ACCESS_KEY_ID=<YOUR_KEY>",
            "AKIAABCDEFGHIJKLMNOP ...",
            "the password field is required",
            "Bearer tokens expire after 1h",
        ] {
            assert!(scan(s).is_none(), "false positive: {s}");
        }
    }
}
