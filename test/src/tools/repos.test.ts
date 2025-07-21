import { configureRepoTools } from '../../../src/tools/repos';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('configureRepoTools', () => {
  let server: McpServer;
  let tokenProvider: jest.Mock;
  let connectionProvider: jest.Mock;
  let mockGitApi: { createPullRequestReviewer: jest.Mock };
  let mockConnection: { getGitApi: jest.Mock };

  beforeEach(() => {
    server = { tool: jest.fn() } as unknown as McpServer;
    tokenProvider = jest.fn();
    mockGitApi = {
      createPullRequestReviewer: jest.fn().mockResolvedValue({ id: 'user1', vote: 10 }),
    };
    mockConnection = { getGitApi: jest.fn().mockResolvedValue(mockGitApi) };
    connectionProvider = jest.fn().mockResolvedValue(mockConnection);
  });

  describe('tool registration', () => {
    it('registers repo_review_pull_request tool on the server', () => {
      configureRepoTools(server, tokenProvider, connectionProvider);
      expect(server.tool).toHaveBeenCalledWith(
        'repo_review_pull_request',
        expect.any(String),
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  describe('repo_review_pull_request handler', () => {
    it('calls createPullRequestReviewer with correct arguments and returns expected result', async () => {
      configureRepoTools(server, tokenProvider, connectionProvider);

      const call = (server.tool as jest.Mock).mock.calls.find(([toolName]) => toolName === 'repo_review_pull_request');
      expect(call).toBeDefined();
      const [, , , handler] = call;

      const toolArgs = {
        reviewer: { id: 'user1', vote: 10 },
        repositoryId: 'repo1',
        pullRequestId: 123,
        reviewerId: 'user1',
        project: 'proj1',
      };

      const result = await handler(toolArgs);

      expect(mockGitApi.createPullRequestReviewer).toHaveBeenCalledWith(
        toolArgs.reviewer,
        toolArgs.repositoryId,
        toolArgs.pullRequestId,
        toolArgs.reviewerId,
        toolArgs.project
      );
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ id: 'user1', vote: 10 }, null, 2) }],
      });
    });

    it('handles API errors gracefully', async () => {
      mockGitApi.createPullRequestReviewer.mockRejectedValue(new Error('API error'));
      configureRepoTools(server, tokenProvider, connectionProvider);

      const call = (server.tool as jest.Mock).mock.calls.find(([toolName]) => toolName === 'repo_review_pull_request');
      const [, , , handler] = call;

      const toolArgs = {
        reviewer: { id: 'user1', vote: 10 },
        repositoryId: 'repo1',
        pullRequestId: 123,
        reviewerId: 'user1',
        project: 'proj1',
      };

      await expect(handler(toolArgs)).rejects.toThrow('API error');
    });
  });
});