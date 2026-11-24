//! `gx-credential mint`: make a gx1 credential from the secret an engine was started with.
//!
//! ```text
//! gx-credential mint --subject <who> --role <editor|playout|engine> [--scope <name>]...
//!                    [--secret-env <NAME> | --secret <value>]
//! ```
//!
//! The secret comes from the environment variable named by `--secret-env` (default
//! `GX_TOKEN_SECRET`), which is the way to give it: a `--secret` value is visible to every process
//! on the machine. A secret shorter than the bind policy's minimum is refused, as the engine
//! refuses to start with one. Scopes are the wire names (`author`, `cue`, `take`, `clear`,
//! `configureOutput`, `stop`, `report`); one the role may not carry is refused. The credential is
//! the only thing printed, so it can be assigned to a variable.

use gx_contracts::auth::{Role, Scope};

use crate::Token;

pub const USAGE: &str = "usage: gx-credential mint --subject <who> --role <editor|playout|engine> [--scope <name>]... [--secret-env <NAME> | --secret <value>]";

fn word<T: serde::de::DeserializeOwned>(kind: &str, value: &str) -> Result<T, String> {
    serde_json::from_value(serde_json::Value::String(value.to_owned()))
        .map_err(|_| format!("{kind} {value:?} is not one the system has"))
}

/// Run the command: `arguments` after the program name, `env` for looking up the secret.
pub fn run(arguments: &[String], env: impl Fn(&str) -> Option<String>) -> Result<String, String> {
    let mut arguments = arguments.iter();
    if arguments.next().map(String::as_str) != Some("mint") {
        return Err(USAGE.into());
    }
    let (mut subject, mut role, mut secret, mut secret_env) = (None, None, None, None);
    let mut scopes: Vec<Scope> = Vec::new();
    while let Some(flag) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))?;
        match flag.as_str() {
            "--subject" if subject.is_none() => subject = Some(value.clone()),
            "--role" if role.is_none() => role = Some(word::<Role>("role", value)?),
            "--scope" => scopes.push(word::<Scope>("scope", value)?),
            "--secret" if secret.is_none() => secret = Some(value.clone()),
            "--secret-env" if secret_env.is_none() => secret_env = Some(value.clone()),
            _ => return Err(format!("unexpected {flag}\n{USAGE}")),
        }
    }
    let subject = subject.ok_or_else(|| format!("--subject is required\n{USAGE}"))?;
    let role = role.ok_or_else(|| format!("--role is required\n{USAGE}"))?;
    if secret.is_some() && secret_env.is_some() {
        return Err("give the secret with --secret or --secret-env, not both".into());
    }
    let secret = match secret {
        Some(secret) => secret,
        None => {
            let name = secret_env.unwrap_or_else(|| "GX_TOKEN_SECRET".to_owned());
            env(&name).ok_or_else(|| {
                format!("no secret: set {name} to the secret the engine was started with")
            })?
        }
    };
    let minimum = gx_contracts::endpoints::MINIMUM_TOKEN_BYTES;
    if secret.len() < minimum {
        return Err(format!(
            "the secret is {} bytes; an engine refuses one shorter than {minimum}",
            secret.len()
        ));
    }
    Token::mint(subject, role, scopes, secret)
        .map(|token| token.as_str().to_owned())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    fn args(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn a_minted_credential_verifies_with_the_secret_and_holds_what_it_was_given() {
        let credential = run(
            &args("mint --subject desk-1 --role editor --scope author --secret-env S"),
            |name| (name == "S").then(|| SECRET.to_owned()),
        )
        .unwrap();
        let claims = Token::parse(credential).unwrap().verify(SECRET).unwrap();
        assert_eq!(claims.subject, "desk-1");
        assert_eq!(claims.role, Role::Editor);
        assert_eq!(claims.scopes, vec![Scope::Author]);
    }

    #[test]
    fn the_default_variable_and_an_explicit_secret_both_work_and_not_together() {
        let by_default = run(
            &args("mint --subject a --role playout --scope take --scope cue"),
            |name| (name == "GX_TOKEN_SECRET").then(|| SECRET.to_owned()),
        )
        .unwrap();
        let claims = Token::parse(by_default).unwrap().verify(SECRET).unwrap();
        assert_eq!(claims.scopes, vec![Scope::Take, Scope::Cue]);
        let flag = format!("mint --subject a --role engine --scope report --secret {SECRET}");
        assert!(run(&args(&flag), no_env).is_ok());
        let both = format!("{flag} --secret-env X");
        assert!(run(&args(&both), no_env).unwrap_err().contains("not both"));
    }

    #[test]
    fn every_way_to_ask_wrongly_is_told_in_words() {
        let with = |text: &str| run(&args(text), |_| Some(SECRET.to_owned())).unwrap_err();
        assert!(run(&[], no_env).unwrap_err().contains("usage"));
        assert!(with("mint --role editor").contains("--subject is required"));
        assert!(with("mint --subject a").contains("--role is required"));
        assert!(with("mint --subject a --role admin").contains("role \"admin\""));
        assert!(with("mint --subject a --role editor --scope root").contains("scope \"root\""));
        assert!(with("mint --subject a --role editor --scope take").contains("not permitted"));
        assert!(with("mint --subject a --role editor --bogus x").contains("unexpected --bogus"));
        assert!(with("mint --subject a --role editor --scope").contains("needs a value"));
        assert!(with("mint --subject a --subject b --role editor").contains("unexpected --subject"));
        assert!(run(&args("mint --subject a --role editor"), no_env)
            .unwrap_err()
            .contains("no secret"));
        let short = run(
            &args("mint --subject a --role editor --secret short"),
            no_env,
        )
        .unwrap_err();
        assert!(short.contains("an engine refuses one shorter"), "{short}");
        assert!(
            !short.contains("secret short"),
            "the secret is never repeated back"
        );
    }
}
