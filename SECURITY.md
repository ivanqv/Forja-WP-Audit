# Security Policy

Security is important to Forja WP Audit.

The project interacts with external WordPress websites and media resources. We aim to handle untrusted content safely and minimize potential risks.

## Supported Versions

Forja WP Audit is currently under development.

Security fixes will target the latest maintained release once the first stable version becomes available.

Older versions may not receive security updates.

## Reporting a Vulnerability

If you discover a security vulnerability, please do not open a public GitHub issue.

Instead, report it privately using GitHub's security advisory feature.

Navigate to the repository's **Security** tab and select **Report a vulnerability**, if private vulnerability reporting is enabled.

If this option is unavailable, please contact the maintainer privately through the contact information provided on [IQV Media](https://iqvmedia.com).

Include the following information whenever possible:

- A description of the vulnerability.
- Steps to reproduce the issue.
- The potential security impact.
- Affected versions or commits.
- A suggested fix, if available.

Please avoid including real credentials, personal information or sensitive data in your report.

## Responsible Disclosure

We appreciate responsible security research.

Please allow reasonable time for the vulnerability to be investigated and addressed before publicly disclosing technical details.

We cannot guarantee specific response or resolution times, but security reports will be reviewed as maintenance capacity allows.

## Security Principles

The project follows these principles:

**Read-only operation**

Forja WP Audit must not modify or delete content on audited WordPress websites.

**Untrusted content**

All external URLs, HTTP responses and downloaded files must be treated as untrusted input.

**Network security**

Requests should be protected against server-side request forgery (SSRF), including unsafe redirects and access to private network addresses.

**Resource limits**

Downloads, request concurrency, file sizes and timeouts should be limited to reduce resource exhaustion risks.

**No credential collection**

The initial version is designed to work with publicly accessible WordPress content and should not require WordPress administrator credentials.

**Safe reporting**

Generated reports must safely handle untrusted filenames, URLs and metadata to prevent script injection.

## Dependencies

Dependencies should be reviewed and kept reasonably up to date.

Security alerts and automated dependency updates may be enabled through GitHub.

## Scope

Security issues involving Forja WP Audit itself are in scope.

Vulnerabilities in third-party WordPress installations, plugins, themes or external services should be reported to their respective maintainers.

Thank you for helping keep Forja WP Audit safe.
