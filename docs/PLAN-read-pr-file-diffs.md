# Plan: Implement 'Read PR File Diffs' Tool Using azure-devops-node-api

## Context
This plan describes how to implement a new MCP server tool for reading file diffs in a Pull Request (PR) using the Azure DevOps Node API. The goal is to provide a tool that, given a PR ID and repository ID, returns the list of changed files and their diffs (additions, deletions, modifications) in a structured format.

## 1. Research & API Capabilities
- **azure-devops-node-api** provides access to PR file diffs via `getPullRequestIterationChanges` (not `getPullRequestChanges`, which does not exist) and file contents via `getItemContent` or `getItem`.
- To get the latest iteration ID, use `getPullRequestIterations` and select the latest.
- The MCP server tools are authored in `src/tools/repos.ts` and should use the established patterns for tool registration and response formatting.
- The tool should be added to the `REPO_TOOLS` object and registered in `configureRepoTools`.

## 2. Tool Design
### Tool Name
- Add a new entry to `REPO_TOOLS`, e.g., `read_pull_request_file_diffs: "repo_read_pull_request_file_diffs"`

### Tool Registration
- Register the tool in `configureRepoTools` with a clear description and input schema:
  - `repositoryId` (string): The ID of the repository.
  - `pullRequestId` (number): The ID of the PR.
  - `top` (number, optional): Max number of files to return.
  - `skip` (number, optional): Number of files to skip.
  - `includeContent` (boolean, optional): Whether to include file content diffs.

### Tool Implementation Steps
1. **Get PR Iteration and Changes**
   - Use `gitApi.getPullRequestIterations(repositoryId, pullRequestId)` to get the list of iterations and select the latest iteration ID.
   - Use `gitApi.getPullRequestIterationChanges(repositoryId, pullRequestId, iterationId)` to retrieve the list of changed files and their change types for the latest iteration.
2. **Format File List**
   - For each file, extract:
     - File path
     - Change type (add, edit, delete, rename)
     - Old/new file path (for renames)
     - Object ID (SHA)
3. **(Optional) Get File Diffs and Context**
   - If `includeContent` is true, for each file:
     - Use `gitApi.getItemContent` or `gitApi.getItem` to fetch before/after content.
     - Compute and format the diff (line-by-line or unified diff format).
     - For each diff region, also extract 50 lines of context before and after the changed lines (ensure bounds are respected).
     - If the diff region is not available, default to the first/last 50 lines of the file.
     - Consider using a diff library (e.g., `diff` npm package) for formatting and identifying changed regions.
4. **Paginate Results**
   - Apply `top` and `skip` to the file list.
5. **Return Structured Response**
   - Compose a well-formatted, readable Markdown output suitable for LLM consumption, not just a raw JSON object.
   - Ensure the output is clear, concise, and highlights file changes and context in a way that is easy for the LLM to process and present to users.

## 3. Consistency & Patterns
- Follow the tool registration and response formatting patterns in `src/tools/repos.ts`.
- Use Zod for input validation.
- Return errors in the same format as other tools.

## 4. Testing & Documentation
- Add unit tests in `test/src/tools/repos.test.ts` for the new tool.
- Document the tool usage in `README.md` and/or `docs/EXAMPLES.md`.

## 5. Future Enhancements
- Support filtering by file path or change type.
- Support diff output formats (unified, side-by-side).
- Support binary file diffs (show as metadata only).

---
**References:**
- MCP server tool patterns: `src/tools/repos.ts`
- Azure DevOps Node API: https://github.com/microsoft/azure-devops-node-api
- Diff libraries: https://www.npmjs.com/package/diff
