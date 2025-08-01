// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AccessToken } from "@azure/identity";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebApi } from "azure-devops-node-api";
import {
  GitRef,
  GitForkRef,
  PullRequestStatus,
  GitQueryCommitsCriteria,
  GitVersionType,
  GitVersionDescriptor,
  GitPullRequestQuery,
  GitPullRequestQueryInput,
  GitPullRequestQueryType,
  CommentThreadContext,
  CommentThreadStatus,
} from "azure-devops-node-api/interfaces/GitInterfaces.js";
import { z } from "zod";
import { GitRepository } from "azure-devops-node-api/interfaces/TfvcInterfaces.js";
import { diffLines } from "diff";
import { getCurrentUserDetails } from "./auth.js";
import { getEnumKeys } from "../utils.js";

const REPO_TOOLS = {
  list_repos_by_project: "repo_list_repos_by_project",
  list_pull_requests_by_repo: "repo_list_pull_requests_by_repo",
  list_pull_requests_by_project: "repo_list_pull_requests_by_project",
  list_branches_by_repo: "repo_list_branches_by_repo",
  list_my_branches_by_repo: "repo_list_my_branches_by_repo",
  list_pull_request_threads: "repo_list_pull_request_threads",
  list_pull_request_thread_comments: "repo_list_pull_request_thread_comments",
  get_repo_by_name_or_id: "repo_get_repo_by_name_or_id",
  get_branch_by_name: "repo_get_branch_by_name",
  get_pull_request_by_id: "repo_get_pull_request_by_id",
  create_pull_request: "repo_create_pull_request",
  update_pull_request: "repo_update_pull_request",
  update_pull_request_reviewers: "repo_update_pull_request_reviewers",
  reply_to_comment: "repo_reply_to_comment",
  create_pull_request_thread: "repo_create_pull_request_thread",
  resolve_comment: "repo_resolve_comment",
  search_commits: "repo_search_commits",
  list_pull_requests_by_commits: "repo_list_pull_requests_by_commits",
  submit_pull_request_vote: "repo_submit_pull_request_vote",
  read_pull_request_file_diffs: "repo_read_pull_request_file_diffs"
};

function branchesFilterOutIrrelevantProperties(branches: GitRef[], top: number) {
  return branches
    ?.flatMap((branch) => (branch.name ? [branch.name] : []))
    ?.filter((branch) => branch.startsWith("refs/heads/"))
    .map((branch) => branch.replace("refs/heads/", ""))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, top);
}

/**
 * Trims comment data to essential properties, filtering out deleted comments
 * @param comments Array of comments to trim (can be undefined/null)
 * @returns Array of trimmed comment objects with essential properties only
 */
function trimComments(comments: unknown[] | undefined | null) {
  return comments
    ?.filter((comment) => {
      const c = comment as Record<string, unknown>;
      return !c.isDeleted;
    }) // Exclude deleted comments
    ?.map((comment) => {
      const c = comment as Record<string, unknown>;
      const author = c.author as Record<string, unknown> | undefined;
      return {
        id: c.id,
        author: {
          displayName: author?.displayName,
          uniqueName: author?.uniqueName,
        },
        content: c.content,
        publishedDate: c.publishedDate,
        lastUpdatedDate: c.lastUpdatedDate,
        lastContentUpdatedDate: c.lastContentUpdatedDate,
      };
    });
}

function pullRequestStatusStringToInt(status: string): number {
  switch (status) {
    case "Abandoned":
      return PullRequestStatus.Abandoned.valueOf();
    case "Active":
      return PullRequestStatus.Active.valueOf();
    case "All":
      return PullRequestStatus.All.valueOf();
    case "Completed":
      return PullRequestStatus.Completed.valueOf();
    case "NotSet":
      return PullRequestStatus.NotSet.valueOf();
    default:
      throw new Error(`Unknown pull request status: ${status}`);
  }
}

function filterReposByName(repositories: GitRepository[], repoNameFilter: string): GitRepository[] {
  const lowerCaseFilter = repoNameFilter.toLowerCase();
  const filteredByName = repositories?.filter((repo) => repo.name?.toLowerCase().includes(lowerCaseFilter));

  return filteredByName;
}

function configureRepoTools(server: McpServer, tokenProvider: () => Promise<AccessToken>, connectionProvider: () => Promise<WebApi>) {
  server.tool(
    REPO_TOOLS.read_pull_request_file_diffs,
    "Read file diffs for a pull request (PR), including changed files and optionally their content diffs.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request to read diffs for."),
      project: z.string().optional().describe("The name or ID of the project (required if repositoryId is a name)."),
      top: z.number().optional().default(100).describe("Max number of files to return."),
      skip: z.number().optional().default(0).describe("Number of files to skip."),
      includeContent: z.boolean().optional().default(false).describe("Whether to include file content diffs."),
    },
    async ({ repositoryId, pullRequestId, project, top, skip, includeContent }) => {
      // Helper function to convert ReadableStream to string
      const streamToString = async (stream: NodeJS.ReadableStream): Promise<string> => {
        return new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', reject);
        });
      };

      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      
      // Get all iterations and select the latest
      const iterations = await gitApi.getPullRequestIterations(repositoryId, pullRequestId, project);
      if (!iterations || iterations.length === 0) {
        return {
          content: [{ type: "text", text: "No iterations found for this pull request." }],
          isError: true,
        };
      }
      const latestIteration = iterations[iterations.length - 1];
      const iterationId = latestIteration.id;
      
      // Get the source and target commit IDs from the iteration
      const sourceCommitId = latestIteration.sourceRefCommit?.commitId;
      const targetCommitId = latestIteration.targetRefCommit?.commitId;
      
      if (!sourceCommitId || !targetCommitId) {
        return {
          content: [{ type: "text", text: "Could not determine source or target commit IDs for this pull request." }],
          isError: true,
        };
      }
      
      // Get changes for the latest iteration
      const changesResult = await gitApi.getPullRequestIterationChanges(repositoryId, pullRequestId, iterationId || 0, project);
      const changes = changesResult?.changeEntries || [];
      // Paginate
      const paginatedChanges = changes.slice(skip, skip + top);

      // Helper to format context with line numbers
      function extractContext(lines: string[], start: number, end: number, context = 5, startLineNumber = 1) {
        const beforeStart = Math.max(0, start - context);
        const afterEnd = Math.min(lines.length, end + context);
        
        const formatLinesWithNumbers = (lineSlice: string[], startNum: number) => {
          return lineSlice.map((line, index) => {
            const lineNum = startNum + index;
            return `${lineNum.toString().padStart(4)}: ${line}`;
          }).join("\n");
        };

        return {
          before: formatLinesWithNumbers(lines.slice(beforeStart, start), startLineNumber + beforeStart),
          changed: formatLinesWithNumbers(lines.slice(start, end), startLineNumber + start),
          after: formatLinesWithNumbers(lines.slice(end, afterEnd), startLineNumber + end),
        };
      }

      // Format Markdown output
      let markdown = `# PR File Diffs\n\n`;
      for (const change of paginatedChanges) {
        markdown += `## ${change.item?.path || "(unknown path)"}\n`;
        markdown += `- **Change Type:** ${change.changeType}\n`;
        if (change.sourceServerItem && change.sourceServerItem !== change.item?.path) {
          markdown += `- **Renamed from:** ${change.sourceServerItem}\n`;
        }
        markdown += `\n`;
        if (includeContent && change.item?.path) {
          let beforeContent = "";
          let afterContent = "";
          try {
            // For before content, get from target branch (what the PR is merging into)
            // For adds, there's no before content
            if (change.changeType !== 1) { // Not an add operation
              const beforeItem = await gitApi.getItemContent(
                repositoryId, 
                change.item.path, 
                project, 
                undefined, // scopePath 
                undefined, // recursionLevel
                undefined, // includeContentMetadata
                undefined, // latestProcessedChange
                undefined, // download
                { 
                  versionType: GitVersionType.Commit,
                  version: targetCommitId
                }
              );
              if (beforeItem) {
                beforeContent = await streamToString(beforeItem);
              }
            }
            
            // For after content, get from source branch (what the PR is bringing in)
            // For deletes, there's no after content
            if (change.changeType !== 2) { // Not a delete operation
              const afterItem = await gitApi.getItemContent(
                repositoryId, 
                change.item.path, 
                project, 
                undefined, // scopePath
                undefined, // recursionLevel
                undefined, // includeContentMetadata
                undefined, // latestProcessedChange
                undefined, // download
                { 
                  versionType: GitVersionType.Commit,
                  version: sourceCommitId
                }
              );
              if (afterItem) {
                afterContent = await streamToString(afterItem);
              }
            }
          } catch (error) {
            // Ignore content errors, just skip diff
            markdown += `*Could not retrieve file content: ${error instanceof Error ? error.message : 'Unknown error'}*\n\n`;
            continue;
          }
          // Split into lines
          const beforeLines = beforeContent.split("\n");
          const afterLines = afterContent.split("\n");
          const diffRegions: {
            type: string;
            beforeStart: number;
            beforeEnd: number;
            afterStart: number;
            afterEnd: number;
          }[] = [];
          
          if (true) {
            // Use diff library to get changed regions
            const changesArr = diffLines(beforeContent, afterContent);
            let beforeIdx = 0, afterIdx = 0;
            for (const part of changesArr) {
              if (part.added) {
                // Added in after
                diffRegions.push({
                  type: "added",
                  beforeStart: beforeIdx,
                  beforeEnd: beforeIdx,
                  afterStart: afterIdx,
                  afterEnd: afterIdx + part.count,
                });
                afterIdx += part.count;
              } else if (part.removed) {
                // Removed from before
                diffRegions.push({
                  type: "removed",
                  beforeStart: beforeIdx,
                  beforeEnd: beforeIdx + part.count,
                  afterStart: afterIdx,
                  afterEnd: afterIdx,
                });
                beforeIdx += part.count;
              } else {
                // Unchanged
                beforeIdx += part.count;
                afterIdx += part.count;
              }
            }
          }
          
          if (diffRegions.length === 0) {
            // No diff regions, just show first/last lines with line numbers
            const maxLines = 50;
            if (beforeLines.length > 0) {
              markdown += `### Before (first ${Math.min(maxLines, beforeLines.length)} lines)\n\n`;
              const beforeFormatted = beforeLines.slice(0, maxLines).map((line, index) => 
                `${(index + 1).toString().padStart(4)}: ${line}`
              ).join("\n");
              markdown += "```diff\n" + beforeFormatted + "\n```\n";
            }
            
            if (afterLines.length > 0) {
              markdown += `\n### After (first ${Math.min(maxLines, afterLines.length)} lines)\n\n`;
              const afterFormatted = afterLines.slice(0, maxLines).map((line, index) => 
                `${(index + 1).toString().padStart(4)}: ${line}`
              ).join("\n");
              markdown += "```diff\n" + afterFormatted + "\n```\n";
            }
          } else {
            for (const region of diffRegions) {
              markdown += `### Diff Region (${region.type}) - Lines ${region.beforeStart + 1}-${region.beforeEnd} → ${region.afterStart + 1}-${region.afterEnd}\n\n`;
              // Before context
              const beforeCtx = extractContext(beforeLines, region.beforeStart, region.beforeEnd, 5, 1);
              if (beforeCtx.before || beforeCtx.changed || beforeCtx.after) {
                markdown += `**Before:**\n\n`;
                markdown += "```diff\n";
                if (beforeCtx.before) markdown += beforeCtx.before + "\n";
                if (beforeCtx.changed) markdown += beforeCtx.changed + "\n";
                if (beforeCtx.after) markdown += beforeCtx.after + "\n";
                markdown += "```\n";
              }
              
              // After context
              const afterCtx = extractContext(afterLines, region.afterStart, region.afterEnd, 5, 1);
              if (afterCtx.before || afterCtx.changed || afterCtx.after) {
                markdown += `\n**After:**\n\n`;
                markdown += "```diff\n";
                if (afterCtx.before) markdown += afterCtx.before + "\n";
                if (afterCtx.changed) markdown += afterCtx.changed + "\n";
                if (afterCtx.after) markdown += afterCtx.after + "\n";
                markdown += "```\n";
              }
            }
          }
        }
        markdown += `\n---\n`;
      }
      return {
        content: [{ type: "text", text: markdown }],
      };
    }
  );
  server.tool(
    REPO_TOOLS.create_pull_request,
    "Create a new pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request will be created."),
      sourceRefName: z.string().describe("The source branch name for the pull request, e.g., 'refs/heads/feature-branch'."),
      targetRefName: z.string().describe("The target branch name for the pull request, e.g., 'refs/heads/main'."),
      title: z.string().describe("The title of the pull request."),
      description: z.string().optional().describe("The description of the pull request. Optional."),
      isDraft: z.boolean().optional().default(false).describe("Indicates whether the pull request is a draft. Defaults to false."),
      workItems: z.string().optional().describe("Work item IDs to associate with the pull request, space-separated."),
      forkSourceRepositoryId: z.string().optional().describe("The ID of the fork repository that the pull request originates from. Optional, used when creating a pull request from a fork."),
    },
    async ({ repositoryId, sourceRefName, targetRefName, title, description, isDraft, workItems, forkSourceRepositoryId }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const workItemRefs = workItems ? workItems.split(" ").map((id) => ({ id: id.trim() })) : [];

      const forkSource: GitForkRef | undefined = forkSourceRepositoryId
        ? {
            repository: {
              id: forkSourceRepositoryId,
            },
          }
        : undefined;

      const pullRequest = await gitApi.createPullRequest(
        {
          sourceRefName,
          targetRefName,
          title,
          description,
          isDraft,
          workItemRefs: workItemRefs,
          forkSource,
        },
        repositoryId
      );

      return {
        content: [{ type: "text", text: JSON.stringify(pullRequest, null, 2) }],
      };
    }
  );
  server.tool(
    REPO_TOOLS.submit_pull_request_vote,
    "Submit your final reviewer vote on a pull request (approve, reject, wait, etc.). This does not perform a full review, only records your decision.",
    {
      repositoryId: z.string().describe("The repository ID of the pull request's target branch."),
      pullRequestId: z.number().describe("ID of the pull request."),
      vote: z.number().describe("Vote value for pull request review: 10=approved, 5=approved with suggestions, 0=no vote, -5=waiting for author, -10=rejected."),
      project: z.string().optional().describe("Project ID or project name (optional)"),
    },
    async ({ repositoryId, pullRequestId, vote,  project }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const data = await getCurrentUserDetails(tokenProvider, connectionProvider);
      const userId = data.authenticatedUser.id;
      const reviewer = {
        id: userId,
        vote
      };
      // Pass project if needed in future
      const result = await gitApi.createPullRequestReviewer(
        reviewer,
        repositoryId,
        pullRequestId,
        userId,
        project
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
  server.tool(
    REPO_TOOLS.update_pull_request,
    "Update a Pull Request by ID with specified fields.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request exists."),
      pullRequestId: z.number().describe("The ID of the pull request to update."),
      title: z.string().optional().describe("The new title for the pull request."),
      description: z.string().optional().describe("The new description for the pull request."),
      isDraft: z.boolean().optional().describe("Whether the pull request should be a draft."),
      targetRefName: z.string().optional().describe("The new target branch name (e.g., 'refs/heads/main')."),
      status: z.enum(["Active", "Abandoned"]).optional().describe("The new status of the pull request. Can be 'Active' or 'Abandoned'."),
    },
    async ({ repositoryId, pullRequestId, title, description, isDraft, targetRefName, status }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      // Build update object with only provided fields
      const updateRequest: {
        title?: string;
        description?: string;
        isDraft?: boolean;
        targetRefName?: string;
        status?: number;
      } = {};
      if (title !== undefined) updateRequest.title = title;
      if (description !== undefined) updateRequest.description = description;
      if (isDraft !== undefined) updateRequest.isDraft = isDraft;
      if (targetRefName !== undefined) updateRequest.targetRefName = targetRefName;
      if (status !== undefined) {
        updateRequest.status = status === "Active" ? PullRequestStatus.Active.valueOf() : PullRequestStatus.Abandoned.valueOf();
      }

      // Validate that at least one field is provided for update
      if (Object.keys(updateRequest).length === 0) {
        return {
          content: [{ type: "text", text: "Error: At least one field (title, description, isDraft, targetRefName, or status) must be provided for update." }],
          isError: true,
        };
      }

      const updatedPullRequest = await gitApi.updatePullRequest(updateRequest, repositoryId, pullRequestId);

      return {
        content: [{ type: "text", text: JSON.stringify(updatedPullRequest, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.update_pull_request_reviewers,
    "Add or remove reviewers for an existing pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request exists."),
      pullRequestId: z.number().describe("The ID of the pull request to update."),
      reviewerIds: z.array(z.string()).describe("List of reviewer ids to add or remove from the pull request."),
      action: z.enum(["add", "remove"]).describe("Action to perform on the reviewers. Can be 'add' or 'remove'."),
    },
    async ({ repositoryId, pullRequestId, reviewerIds, action }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      let updatedPullRequest;
      if (action === "add") {
        updatedPullRequest = await gitApi.createPullRequestReviewers(
          reviewerIds.map((id) => ({ id: id })),
          repositoryId,
          pullRequestId
        );

        return {
          content: [{ type: "text", text: JSON.stringify(updatedPullRequest, null, 2) }],
        };
      } else {
        for (const reviewerId of reviewerIds) {
          await gitApi.deletePullRequestReviewer(repositoryId, pullRequestId, reviewerId);
        }

        return {
          content: [{ type: "text", text: `Reviewers with IDs ${reviewerIds.join(", ")} removed from pull request ${pullRequestId}.` }],
        };
      }
    }
  );

  server.tool(
    REPO_TOOLS.list_repos_by_project,
    "Retrieve a list of repositories for a given project",
    {
      project: z.string().describe("The name or ID of the Azure DevOps project."),
      top: z.number().default(100).describe("The maximum number of repositories to return."),
      skip: z.number().default(0).describe("The number of repositories to skip. Defaults to 0."),
      repoNameFilter: z.string().optional().describe("Optional filter to search for repositories by name. If provided, only repositories with names containing this string will be returned."),
    },
    async ({ project, top, skip, repoNameFilter }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const repositories = await gitApi.getRepositories(project, false, false, false);

      const filteredRepositories = repoNameFilter ? filterReposByName(repositories, repoNameFilter) : repositories;

      const paginatedRepositories = filteredRepositories?.sort((a, b) => a.name?.localeCompare(b.name ?? "") ?? 0).slice(skip, skip + top);

      // Filter out the irrelevant properties
      const trimmedRepositories = paginatedRepositories?.map((repo) => ({
        id: repo.id,
        name: repo.name,
        isDisabled: repo.isDisabled,
        isFork: repo.isFork,
        isInMaintenance: repo.isInMaintenance,
        webUrl: repo.webUrl,
        size: repo.size,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(trimmedRepositories, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.list_pull_requests_by_repo,
    "Retrieve a list of pull requests for a given repository.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull requests are located."),
      top: z.number().default(100).describe("The maximum number of pull requests to return."),
      skip: z.number().default(0).describe("The number of pull requests to skip."),
      created_by_me: z.boolean().default(false).describe("Filter pull requests created by the current user."),
      i_am_reviewer: z.boolean().default(false).describe("Filter pull requests where the current user is a reviewer."),
      status: z
        .enum(getEnumKeys(PullRequestStatus) as [string, ...string[]])
        .default("Active")
        .describe("Filter pull requests by status. Defaults to 'Active'."),
    },
    async ({ repositoryId, top, skip, created_by_me, i_am_reviewer, status }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      // Build the search criteria
      const searchCriteria: {
        status: number;
        repositoryId: string;
        creatorId?: string;
        reviewerId?: string;
      } = {
        status: pullRequestStatusStringToInt(status),
        repositoryId: repositoryId,
      };

      if (created_by_me || i_am_reviewer) {
        const data = await getCurrentUserDetails(tokenProvider, connectionProvider);
        const userId = data.authenticatedUser.id;
        if (created_by_me) {
          searchCriteria.creatorId = userId;
        }
        if (i_am_reviewer) {
          searchCriteria.reviewerId = userId;
        }
      }

      const pullRequests = await gitApi.getPullRequests(
        repositoryId,
        searchCriteria,
        undefined, // project
        undefined, // maxCommentLength
        skip,
        top
      );

      // Filter out the irrelevant properties
      const filteredPullRequests = pullRequests?.map((pr) => ({
        pullRequestId: pr.pullRequestId,
        codeReviewId: pr.codeReviewId,
        status: pr.status,
        createdBy: {
          displayName: pr.createdBy?.displayName,
          uniqueName: pr.createdBy?.uniqueName,
        },
        creationDate: pr.creationDate,
        title: pr.title,
        isDraft: pr.isDraft,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(filteredPullRequests, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.list_pull_requests_by_project,
    "Retrieve a list of pull requests for a given project Id or Name.",
    {
      project: z.string().describe("The name or ID of the Azure DevOps project."),
      top: z.number().default(100).describe("The maximum number of pull requests to return."),
      skip: z.number().default(0).describe("The number of pull requests to skip."),
      created_by_me: z.boolean().default(false).describe("Filter pull requests created by the current user."),
      i_am_reviewer: z.boolean().default(false).describe("Filter pull requests where the current user is a reviewer."),
      status: z
        .enum(getEnumKeys(PullRequestStatus) as [string, ...string[]])
        .default("Active")
        .describe("Filter pull requests by status. Defaults to 'Active'."),
    },
    async ({ project, top, skip, created_by_me, i_am_reviewer, status }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      // Build the search criteria
      const gitPullRequestSearchCriteria: {
        status: number;
        creatorId?: string;
        reviewerId?: string;
      } = {
        status: pullRequestStatusStringToInt(status),
      };

      if (created_by_me || i_am_reviewer) {
        const data = await getCurrentUserDetails(tokenProvider, connectionProvider);
        const userId = data.authenticatedUser.id;
        if (created_by_me) {
          gitPullRequestSearchCriteria.creatorId = userId;
        }
        if (i_am_reviewer) {
          gitPullRequestSearchCriteria.reviewerId = userId;
        }
      }

      const pullRequests = await gitApi.getPullRequestsByProject(
        project,
        gitPullRequestSearchCriteria,
        undefined, // maxCommentLength
        skip,
        top
      );

      // Filter out the irrelevant properties
      const filteredPullRequests = pullRequests?.map((pr) => ({
        pullRequestId: pr.pullRequestId,
        codeReviewId: pr.codeReviewId,
        repository: pr.repository?.name,
        status: pr.status,
        createdBy: {
          displayName: pr.createdBy?.displayName,
          uniqueName: pr.createdBy?.uniqueName,
        },
        creationDate: pr.creationDate,
        title: pr.title,
        isDraft: pr.isDraft,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(filteredPullRequests, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.list_pull_request_threads,
    "Retrieve a list of comment threads for a pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request for which to retrieve threads."),
      project: z.string().optional().describe("Project ID or project name (optional)"),
      iteration: z.number().optional().describe("The iteration ID for which to retrieve threads. Optional, defaults to the latest iteration."),
      baseIteration: z.number().optional().describe("The base iteration ID for which to retrieve threads. Optional, defaults to the latest base iteration."),
      top: z.number().default(100).describe("The maximum number of threads to return."),
      skip: z.number().default(0).describe("The number of threads to skip."),
      fullResponse: z.boolean().optional().default(false).describe("Return full thread JSON response instead of trimmed data."),
    },
    async ({ repositoryId, pullRequestId, project, iteration, baseIteration, top, skip, fullResponse }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      const threads = await gitApi.getThreads(repositoryId, pullRequestId, project, iteration, baseIteration);

      const paginatedThreads = threads?.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).slice(skip, skip + top);

      if (fullResponse) {
        return {
          content: [{ type: "text", text: JSON.stringify(paginatedThreads, null, 2) }],
        };
      }

      // Return trimmed thread data focusing on essential information
      const trimmedThreads = paginatedThreads?.map((thread) => ({
        id: thread.id,
        publishedDate: thread.publishedDate,
        lastUpdatedDate: thread.lastUpdatedDate,
        status: thread.status,
        comments: trimComments(thread.comments),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(trimmedThreads, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.list_pull_request_thread_comments,
    "Retrieve a list of comments in a pull request thread.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request for which to retrieve thread comments."),
      threadId: z.number().describe("The ID of the thread for which to retrieve comments."),
      project: z.string().optional().describe("Project ID or project name (optional)"),
      top: z.number().default(100).describe("The maximum number of comments to return."),
      skip: z.number().default(0).describe("The number of comments to skip."),
      fullResponse: z.boolean().optional().default(false).describe("Return full comment JSON response instead of trimmed data."),
    },
    async ({ repositoryId, pullRequestId, threadId, project, top, skip, fullResponse }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      // Get thread comments - GitApi uses getComments for retrieving comments from a specific thread
      const comments = await gitApi.getComments(repositoryId, pullRequestId, threadId, project);

      const paginatedComments = comments?.sort((a, b) => (a.id ?? 0) - (b.id ?? 0)).slice(skip, skip + top);

      if (fullResponse) {
        return {
          content: [{ type: "text", text: JSON.stringify(paginatedComments, null, 2) }],
        };
      }

      // Return trimmed comment data focusing on essential information
      const trimmedComments = trimComments(paginatedComments);

      return {
        content: [{ type: "text", text: JSON.stringify(trimmedComments, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.list_branches_by_repo,
    "Retrieve a list of branches for a given repository.",
    {
      repositoryId: z.string().describe("The ID of the repository where the branches are located."),
      top: z.number().default(100).describe("The maximum number of branches to return. Defaults to 100."),
    },
    async ({ repositoryId, top }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const branches = await gitApi.getRefs(repositoryId, undefined);

      const filteredBranches = branchesFilterOutIrrelevantProperties(branches, top);

      return {
        content: [{ type: "text", text: JSON.stringify(filteredBranches, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.list_my_branches_by_repo,
    "Retrieve a list of my branches for a given repository Id.",
    {
      repositoryId: z.string().describe("The ID of the repository where the branches are located."),
      top: z.number().default(100).describe("The maximum number of branches to return."),
    },
    async ({ repositoryId, top }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const branches = await gitApi.getRefs(repositoryId, undefined, undefined, undefined, undefined, true);

      const filteredBranches = branchesFilterOutIrrelevantProperties(branches, top);

      return {
        content: [{ type: "text", text: JSON.stringify(filteredBranches, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.get_repo_by_name_or_id,
    "Get the repository by project and repository name or ID.",
    {
      project: z.string().describe("Project name or ID where the repository is located."),
      repositoryNameOrId: z.string().describe("Repository name or ID."),
    },
    async ({ project, repositoryNameOrId }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const repositories = await gitApi.getRepositories(project);

      const repository = repositories?.find((repo) => repo.name === repositoryNameOrId || repo.id === repositoryNameOrId);

      if (!repository) {
        throw new Error(`Repository ${repositoryNameOrId} not found in project ${project}`);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(repository, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.get_branch_by_name,
    "Get a branch by its name.",
    {
      repositoryId: z.string().describe("The ID of the repository where the branch is located."),
      branchName: z.string().describe("The name of the branch to retrieve, e.g., 'main' or 'feature-branch'."),
    },
    async ({ repositoryId, branchName }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const branches = await gitApi.getRefs(repositoryId);
      const branch = branches?.find((branch) => branch.name === `refs/heads/${branchName}`);
      if (!branch) {
        return {
          content: [
            {
              type: "text",
              text: `Branch ${branchName} not found in repository ${repositoryId}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(branch, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.get_pull_request_by_id,
    "Get a pull request by its ID.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request to retrieve."),
      includeWorkItemRefs: z.boolean().optional().default(false).describe("Whether to reference work items associated with the pull request."),
    },
    async ({ repositoryId, pullRequestId, includeWorkItemRefs }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const pullRequest = await gitApi.getPullRequest(repositoryId, pullRequestId, undefined, undefined, undefined, undefined, undefined, includeWorkItemRefs);
      return {
        content: [{ type: "text", text: JSON.stringify(pullRequest, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.reply_to_comment,
    "Replies to a specific comment on a pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request where the comment thread exists."),
      threadId: z.number().describe("The ID of the thread to which the comment will be added."),
      content: z.string().describe("The content of the comment to be added."),
      project: z.string().optional().describe("Project ID or project name (optional)"),
      fullResponse: z.boolean().optional().default(false).describe("Return full comment JSON response instead of a simple confirmation message."),
    },
    async ({ repositoryId, pullRequestId, threadId, content, project, fullResponse }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const comment = await gitApi.createComment({ content }, repositoryId, pullRequestId, threadId, project);

      // Check if the comment was successfully created
      if (!comment) {
        return {
          content: [{ type: "text", text: `Error: Failed to add comment to thread ${threadId}. The comment was not created successfully.` }],
          isError: true,
        };
      }

      if (fullResponse) {
        return {
          content: [{ type: "text", text: JSON.stringify(comment, null, 2) }],
        };
      }

      return {
        content: [{ type: "text", text: `Comment successfully added to thread ${threadId}.` }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.create_pull_request_thread,
    "Creates a new comment thread on a pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request where the comment thread exists."),
      content: z.string().describe("The content of the comment to be added."),
      project: z.string().optional().describe("Project ID or project name (optional)"),
      filePath: z.string().optional().describe("The path of the file where the comment thread will be created. (optional)"),
      status: z
        .enum(getEnumKeys(CommentThreadStatus) as [string, ...string[]])
        .optional()
        .default(CommentThreadStatus[CommentThreadStatus.Active])
        .describe("The status of the comment thread. Defaults to 'Active'."),
      rightFileStartLine: z.number().optional().describe("Position of first character of the thread's span in right file. The line number of a thread's position. Starts at 1. (optional)"),
      rightFileStartOffset: z
        .number()
        .optional()
        .describe(
          "Position of first character of the thread's span in right file. The line number of a thread's position. The character offset of a thread's position inside of a line. Starts at 1. Must only be set if rightFileStartLine is also specified. (optional)"
        ),
      rightFileEndLine: z
        .number()
        .optional()
        .describe(
          "Position of last character of the thread's span in right file. The line number of a thread's position. Starts at 1. Must only be set if rightFileStartLine is also specified. (optional)"
        ),
      rightFileEndOffset: z
        .number()
        .optional()
        .describe(
          "Position of last character of the thread's span in right file. The character offset of a thread's position inside of a line. Must only be set if rightFileEndLine is also specified. (optional)"
        ),
    },
    async ({ repositoryId, pullRequestId, content, project, filePath, status, rightFileStartLine, rightFileStartOffset, rightFileEndLine, rightFileEndOffset }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();

      const threadContext: CommentThreadContext = { filePath: filePath };

      if (rightFileStartLine !== undefined) {
        if (rightFileStartLine < 1) {
          throw new Error("rightFileStartLine must be greater than or equal to 1.");
        }

        threadContext.rightFileStart = { line: rightFileStartLine };

        if (rightFileStartOffset !== undefined) {
          if (rightFileStartOffset < 1) {
            throw new Error("rightFileStartOffset must be greater than or equal to 1.");
          }

          threadContext.rightFileStart.offset = rightFileStartOffset;
        }
      }

      if (rightFileEndLine !== undefined) {
        if (rightFileStartLine === undefined) {
          throw new Error("rightFileEndLine must only be specified if rightFileStartLine is also specified.");
        }

        if (rightFileEndLine < 1) {
          throw new Error("rightFileEndLine must be greater than or equal to 1.");
        }

        threadContext.rightFileEnd = { line: rightFileEndLine };

        if (rightFileEndOffset !== undefined) {
          if (rightFileEndOffset < 1) {
            throw new Error("rightFileEndOffset must be greater than or equal to 1.");
          }

          threadContext.rightFileEnd.offset = rightFileEndOffset;
        }
      }

      const thread = await gitApi.createThread(
        { comments: [{ content: content }], threadContext: threadContext, status: CommentThreadStatus[status as keyof typeof CommentThreadStatus] },
        repositoryId,
        pullRequestId,
        project
      );

      return {
        content: [{ type: "text", text: JSON.stringify(thread, null, 2) }],
      };
    }
  );

  server.tool(
    REPO_TOOLS.resolve_comment,
    "Resolves a specific comment thread on a pull request.",
    {
      repositoryId: z.string().describe("The ID of the repository where the pull request is located."),
      pullRequestId: z.number().describe("The ID of the pull request where the comment thread exists."),
      threadId: z.number().describe("The ID of the thread to be resolved."),
      fullResponse: z.boolean().optional().default(false).describe("Return full thread JSON response instead of a simple confirmation message."),
    },
    async ({ repositoryId, pullRequestId, threadId, fullResponse }) => {
      const connection = await connectionProvider();
      const gitApi = await connection.getGitApi();
      const thread = await gitApi.updateThread(
        { status: 2 }, // 2 corresponds to "Resolved" status
        repositoryId,
        pullRequestId,
        threadId
      );

      // Check if the thread was successfully resolved
      if (!thread) {
        return {
          content: [{ type: "text", text: `Error: Failed to resolve thread ${threadId}. The thread status was not updated successfully.` }],
          isError: true,
        };
      }

      if (fullResponse) {
        return {
          content: [{ type: "text", text: JSON.stringify(thread, null, 2) }],
        };
      }

      return {
        content: [{ type: "text", text: `Thread ${threadId} was successfully resolved.` }],
      };
    }
  );

  const gitVersionTypeStrings = Object.values(GitVersionType).filter((value): value is string => typeof value === "string");

  server.tool(
    REPO_TOOLS.search_commits,
    "Searches for commits in a repository",
    {
      project: z.string().describe("Project name or ID"),
      repository: z.string().describe("Repository name or ID"),
      fromCommit: z.string().optional().describe("Starting commit ID"),
      toCommit: z.string().optional().describe("Ending commit ID"),
      version: z.string().optional().describe("The name of the branch, tag or commit to filter commits by"),
      versionType: z
        .enum(gitVersionTypeStrings as [string, ...string[]])
        .optional()
        .default(GitVersionType[GitVersionType.Branch])
        .describe("The meaning of the version parameter, e.g., branch, tag or commit"),
      skip: z.number().optional().default(0).describe("Number of commits to skip"),
      top: z.number().optional().default(10).describe("Maximum number of commits to return"),
      includeLinks: z.boolean().optional().default(false).describe("Include commit links"),
      includeWorkItems: z.boolean().optional().default(false).describe("Include associated work items"),
    },
    async ({ project, repository, fromCommit, toCommit, version, versionType, skip, top, includeLinks, includeWorkItems }) => {
      try {
        const connection = await connectionProvider();
        const gitApi = await connection.getGitApi();

        const searchCriteria: GitQueryCommitsCriteria = {
          fromCommitId: fromCommit,
          toCommitId: toCommit,
          includeLinks: includeLinks,
          includeWorkItems: includeWorkItems,
        };

        if (version) {
          const itemVersion: GitVersionDescriptor = {
            version: version,
            versionType: GitVersionType[versionType as keyof typeof GitVersionType],
          };
          searchCriteria.itemVersion = itemVersion;
        }

        const commits = await gitApi.getCommits(
          repository,
          searchCriteria,
          project,
          skip, // skip
          top
        );

        return {
          content: [{ type: "text", text: JSON.stringify(commits, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching commits: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  const pullRequestQueryTypesStrings = Object.values(GitPullRequestQueryType).filter((value): value is string => typeof value === "string");

  server.tool(
    REPO_TOOLS.list_pull_requests_by_commits,
    "Lists pull requests by commit IDs to find which pull requests contain specific commits",
    {
      project: z.string().describe("Project name or ID"),
      repository: z.string().describe("Repository name or ID"),
      commits: z.array(z.string()).describe("Array of commit IDs to query for"),
      queryType: z
        .enum(pullRequestQueryTypesStrings as [string, ...string[]])
        .optional()
        .default(GitPullRequestQueryType[GitPullRequestQueryType.LastMergeCommit])
        .describe("Type of query to perform"),
    },
    async ({ project, repository, commits, queryType }) => {
      try {
        const connection = await connectionProvider();
        const gitApi = await connection.getGitApi();

        const query: GitPullRequestQuery = {
          queries: [
            {
              items: commits,
              type: GitPullRequestQueryType[queryType as keyof typeof GitPullRequestQueryType],
            } as GitPullRequestQueryInput,
          ],
        };

        const queryResult = await gitApi.getPullRequestQuery(query, repository, project);

        return {
          content: [{ type: "text", text: JSON.stringify(queryResult, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error querying pull requests by commits: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export { REPO_TOOLS, configureRepoTools };
