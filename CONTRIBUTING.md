# Contributing to Forja WP Audit

First of all, thank you for considering contributing to Forja WP Audit!

This project aims to provide a simple, reliable and open-source toolkit for auditing WordPress media before migrating or optimizing websites.

Contributions of all sizes are welcome, including bug fixes, documentation improvements, tests and new features.

## Getting Started

Before contributing:

1. Read the README to understand the project's goals and current capabilities.
2. Check existing issues and pull requests to avoid duplicating work.
3. For significant changes or new features, open an issue first to discuss your proposal.

Small bug fixes and documentation improvements can be submitted directly.

## Development Setup

Requirements:

- Node.js 22 or later.
- pnpm.
- Git.

Fork the repository and clone your fork:

```bash
git clone https://github.com/YOUR_USERNAME/forja-wp-audit.git
cd forja-wp-audit
```

Install dependencies:

```bash
pnpm install
```

Once the initial development setup is available, the project will provide commands for development, linting, type checking and automated tests.

Refer to `package.json` for the currently supported commands.

## Branch Naming

Create a dedicated branch for your changes.

Recommended naming conventions:

- `feat/description` — New features.
- `fix/description` — Bug fixes.
- `docs/description` — Documentation changes.
- `test/description` — Test improvements.
- `refactor/description` — Code improvements without functional changes.

Example:

```bash
git checkout -b feat/duplicate-detection
```

## Coding Guidelines

Please follow these principles:

- Use TypeScript with strict type checking.
- Keep functions small and focused.
- Prefer simple solutions over unnecessary abstractions.
- Write tests for new functionality and bug fixes.
- Avoid adding dependencies unless they provide clear value.
- Follow the existing project structure and conventions.

The auditing engine should remain independent of the CLI and reporting interfaces.

## Project Principles

Forja WP Audit follows several important principles.

**Read-only by design**

The tool must never modify or delete content on the audited WordPress website.

**Privacy and security**

Avoid exposing credentials, private URLs or sensitive website information in logs, tests and example reports.

**Performance**

Use reasonable concurrency limits and avoid overwhelming WordPress servers with unnecessary requests.

**Accuracy**

Distinguish confirmed duplicate files from potentially similar images. Never report estimated storage savings as guaranteed results.

**Independence**

The toolkit must work independently of ForjaCMS or any other commercial product.

## Testing

Before submitting a pull request:

- Run the available automated tests.
- Run linting and TypeScript checks.
- Add tests covering new functionality.
- Verify that existing functionality remains unaffected.

Do not use third-party production websites for automated integration tests. Prefer mocked API responses and synthetic media fixtures.

## Pull Requests

When submitting a pull request:

1. Keep your changes focused on a single issue or feature.
2. Provide a clear description of the problem and your solution.
3. Reference related issues when applicable.
4. Explain how your changes were tested.
5. Include screenshots when modifying the HTML report.
6. Update the documentation if necessary.

All pull requests must pass the project's automated checks before merging, once those checks are configured.

The maintainer may request changes before accepting a contribution.

Submitting a pull request does not guarantee that it will be merged.

## Commit Messages

We recommend using Conventional Commits.

Examples:

- `feat: add image hash comparison`
- `fix: handle broken image redirects`
- `docs: improve installation instructions`
- `test: add duplicate detection coverage`

## Reporting Bugs

Please open a GitHub issue with:

- A clear description of the problem.
- Steps to reproduce it.
- Expected and actual behavior.
- Your Node.js version.
- Relevant logs or screenshots, with sensitive information removed.

For security vulnerabilities, please follow our SECURITY.md instead of opening a public issue.

## License

By contributing to this repository, you agree that your contributions will be licensed under the project's MIT License.

Thank you for helping improve Forja WP Audit!

**Iván Quintas**  
Creator of [ForjaCMS](https://forjacms.com)
