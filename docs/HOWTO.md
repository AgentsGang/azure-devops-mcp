Before you get started, ensure you follow the steps in the `README.md` file. This will help you get up and running and connected to your Azure DevOps organization.

## ✏️ Modify Copilot Instructions

The `.github/copilot-instructions.md` file is a great way to customize the GitHub Copilot experience, especially when working with MCP Server for Azure DevOps.

From the [GitHub documentation](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot):

> Instead of repeatedly adding this contextual detail to your chat questions, you can create a file in your repository that automatically adds this information for you. The additional information is not displayed in the chat but is available to Copilot to allow it to generate higher-quality responses.

#### Example Modification

Here is an example modification you can add to your existing `.github/copilot-instructions.md` file.

```markdown
## Using MCP Server for Azure DevOps

When getting work items using MCP Server for Azure DevOps, always try to use batch tools for updates instead of many individual single updates. For updates, try and update up to 200 updates in a single batch. When getting work items, once you get the list of IDs, use the tool `get_work_items_batch_by_ids` to get the work item details. By default, show fields ID, Type, Title, State. Show work item results in a rendered markdown table.
```

## Sequential Thinking

The [Sequential Thinking](https://mcp.so/server/sequentialthinking) component helps break down complex problems into manageable steps, enabling the LLM to better understand your goals. If you encounter issues with the LLM's responses, consider adding the Sequential Thinking MCP Server to your `.vscode/mcp.json` file:

```json
{
  "inputs": [
    {
      "id": "ado_org",
      "type": "promptString",
      "description": "Azure DevOps organization name  (e.g. 'contoso')"
    }
  ],   
  "servers": {
    "ado": {
      "type": "stdio",
      "command": "mcp-server-azuredevops",
      "args": ["${input:ado_org}"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

## 🎯 Different Models

Communicating with the LLM is both an art and a science. If the model does not respond well, switching to a different model may improve your results.

## 🚗 Using MCP Server in Visual Studio Code

### Start the Azure DevOps MCP Server:

To start the Azure DevOps MCP Server, open the `.vscode\mcp.json` file and click 'Start'

<img src="./media/start-mcp-server.gif" alt="start mcp server" width="250"/>

Enter your Azure DevOps organization name (e.g. `contoso`).

In chat, switch to [Agent Mode](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode).

### Enable or disable tools

Click "Select Tools" and choose the available `ado_` tools.

<img src="./media/configure-mcp-server-tools.gif" alt="configure mcp server tools" width="300"/>

## 📽️ Examples

> 📝 These examples have been tested and validated only in English. If you encounter issues when using a different language, please open an issue in the repository so we can investigate.

### ✔️ Projects and teams

Most work item tools require project context. You can retrieve the list of projects and specify the desired project:

```plaintext
get list of ado projects
```

This command returns all Azure DevOps projects for the organization defined in the `mcp.json` file. Similarly, you can retrieve the team context:

```plaintext
get list of teams for project contoso
```

[![MPC Server for Azure DevOps: Get list of projects and teams](https://i9.ytimg.com/vi_webp/x579E4_jNtY/mqdefault.webp?sqp=CKjRi8IG&rs=AOn4CLCoy-3jlT_XHBNvCyQG7zFrEdwRxw)](https://youtu.be/x579E4_jNtY "MPC Server for Azure DevOps: Get list of projects and teams")


### ✔️ Get my work items

Retrieve a list of work items assigned to you. This tool requires project context:

```plaintext
get my work items for project contoso
```

The model should automatically use the `ado_get_work_items_batch_by_ids` tool to fetch work item details.

[![MPC Server for Azure DevOps: Get my work items](https://i9.ytimg.com/vi_webp/y_ri8n7mBlg/mqdefault.webp?sqp=CKjRi8IG&rs=AOn4CLBiYBecaLow3qUw7AsRwNmbe-Bgig)](https://youtu.be/y_ri8n7mBlg "MPC Server for Azure DevOps: Get my work items")

### ✔️ Get all work items in a backlog

You need project, team and backlog (Epics, Stories, Features) context in order to get a list of all the work items in a backlog.

```plaintext
get backlogs for Contoso project and Fabrikam Team
```

Once you have the backlog levels, you can then get work items for that backlog.

```plaintext
get list of work items for Features backlog
```

The model should automatically use the `ado_get_work_items_batch_by_ids` tool to fetch work item details.

[![MPC Server for Azure DevOps: Get backlog](https://i9.ytimg.com/vi/LouuyoscNrI/mqdefault.jpg?sqp=CKjRi8IG-oaymwEmCMACELQB8quKqQMa8AEB-AH-CYAC0AWKAgwIABABGFsgWyhbMA8=&rs=AOn4CLBZHRzzFXZtIMG8RQzNU7exGui8kg)](https://youtu.be/LouuyoscNrI "MPC Server for Azure DevOps: Get backlog")

### ✔️ Retrieve and edit work items

Get a work item, get the work item comments, update the work item fields, and add a new comment.

```plaintext
Get work item 12345 and show me fields ID, Type, State, Repro Steps, Story Points, and Priority. Get all comments for the work item and summarize them for me.
```

The model now has context of the work item. You can then update specific fields. In this case, we want the LLM to generate a better set of Repro Steps and then update the work item with those new steps. Along with updating the Story Points and State fields.

```plaintext
Polish the Repro Steps with more information and details. Then take that value and update the work item. Also update StoryPoints = 5 and State = Active.
```
Add an follow up update to assign the work item to me and add a new comment.

```plaintext
Assign this work item to myemail@outlook.com and add a comment "I will own this Bug and get it fixed"
```

[![MPC Server for Azure DevOps: Work with Work Items](https://i9.ytimg.com/vi/tT7wqSIPKdA/mqdefault.jpg?sqp=CNiljMIG-oaymwEmCMACELQB8quKqQMa8AEB-AH-CYAC0AWKAgwIABABGCogVChyMA8=&rs=AOn4CLDiAUFB07UFK5kAYTGFtH-gAzhqhQ)](https://youtu.be/tT7wqSIPKdA "MPC Server for Azure DevOps: Work with Work Items")
