# Writing the docs

The docs live in this repository as Markdown and are built into a site with
[MkDocs](https://www.mkdocs.org/). They are treated like code: changed on a branch,
reviewed in a pull request and checked automatically before they are merged.

## How to change the docs

1. Create a branch from `main`.
2. Edit or add Markdown files in `docs/`. Diagrams are written in
   [Mermaid](https://mermaid.js.org/) inside the Markdown.
3. Update the docs in the **same pull request** as the code they describe.
4. Open a pull request. The template asks what changed, why, and which docs
   were updated.
5. A teammate reviews it for clarity, accuracy, completeness and consistency.
6. Once approved and all checks pass, merge it.

Big decisions are recorded as [decision records (ADRs)](adr/index.md), one per
pull request.

## Changing a decision

ADRs are the history of **why** we chose something; the other pages describe
**how things are now**. So they change in different ways:

- **Proposed ADR:** rewrite it freely while it is being reviewed.
- **Accepted ADR:** don't rewrite the decision. Write a new ADR that says
  "Supersedes ADR-NNNN" and explains in its Context why the old decision no
  longer fits. In the old ADR, change only the status to
  "Superseded by ADR-NNNN", with a link, and update its row in the ADR index.
- **Small fixes** (typos, broken links, formatting) are fine in any ADR.
- **Other pages** (Architecture, Setup Guide, API and so on) are updated in
  place, in the same pull request as the change they describe.

## Automatic checks

Every pull request that changes the docs runs these checks
(`.github/workflows/docs.yml`). Only merge a pull request once they all pass.

| Check | What it catches | Tool |
|---|---|---|
| Build site (strict) | The site fails to build, or a link between pages is broken | `mkdocs build --strict` |
| Markdown lint | Inconsistent formatting | [markdownlint](https://github.com/DavidAnson/markdownlint) |
| Spell check | Common misspellings | [codespell](https://github.com/codespell-project/codespell) |
| Link check | Links to other websites that no longer work | [lychee](https://github.com/lycheeverse/lychee) |

GitGuardian also scans every pull request for leaked secrets such as API keys.

## Publishing

When a pull request that changes the docs is merged into `main`, the
`Deploy docs` workflow (`.github/workflows/deploy-docs.yml`) builds the site
and publishes it to <https://wh1te-shad0w.github.io/ai-dubbing-studio/>.
It can also be run by hand from the Actions tab.

## Run the checks locally

From the repository root:

```bash
pip install -r requirements-docs.txt codespell==2.4.1
mkdocs serve                      # preview at http://127.0.0.1:8000
mkdocs build --strict             # build check
npx markdownlint-cli2@0.18.1      # markdown lint (rules in .markdownlint-cli2.yaml)
codespell docs README.md mkdocs.yml
```

The link check runs only in CI.
