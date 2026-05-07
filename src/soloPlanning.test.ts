import { describe, expect, it } from "vitest";
import {
  AmbiguousScratchpadSelectionError,
  createOrUpdateScratchpadPlan,
  locateSelectedScratchpad,
  type SoloClient,
  type SoloScratchpad,
  type SoloTodo
} from "./soloPlanning.js";

class FakeSoloClient implements SoloClient {
  public scratchpads: SoloScratchpad[];
  public todos: SoloTodo[];
  public createTodoCalls = 0;
  public commentsAdded = 0;
  public tagsAdded = 0;
  public blockersSet = 0;

  constructor(input: { scratchpads: SoloScratchpad[]; todos?: SoloTodo[] }) {
    this.scratchpads = input.scratchpads;
    this.todos = input.todos ?? [];
  }

  async listScratchpads(projectId: number): Promise<SoloScratchpad[]> {
    return this.scratchpads.filter((scratchpad) => scratchpad.projectId === projectId);
  }

  async updateScratchpad(uri: string, patch: { content: string }): Promise<SoloScratchpad> {
    const index = this.scratchpads.findIndex((scratchpad) => scratchpad.uri === uri);
    if (index === -1) {
      throw new Error(`missing scratchpad ${uri}`);
    }
    this.scratchpads[index] = { ...this.scratchpads[index], ...patch };
    return this.scratchpads[index];
  }

  async listTodos(projectId: number): Promise<SoloTodo[]> {
    return this.todos.filter((todo) => todo.projectId === projectId);
  }

  async createTodo(input: {
    projectId: number;
    title: string;
    body?: string;
    tags: string[];
  }): Promise<SoloTodo> {
    this.createTodoCalls += 1;
    const todo: SoloTodo = {
      uri: `solo://proj/${input.projectId}/todo/${this.createTodoCalls}`,
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      tags: [...input.tags],
      comments: [],
      blockedBy: []
    };
    this.todos.push(todo);
    return todo;
  }

  async addTodoTags(uri: string, tags: string[]): Promise<SoloTodo> {
    this.tagsAdded += 1;
    return this.updateTodo(uri, (todo) => ({
      ...todo,
      tags: [...new Set([...todo.tags, ...tags])]
    }));
  }

  async addTodoComment(uri: string, body: string): Promise<SoloTodo> {
    this.commentsAdded += 1;
    return this.updateTodo(uri, (todo) => ({
      ...todo,
      comments: [...todo.comments, { body }]
    }));
  }

  async setTodoBlockers(uri: string, blockedBy: string[]): Promise<SoloTodo> {
    this.blockersSet += 1;
    return this.updateTodo(uri, (todo) => ({
      ...todo,
      blockedBy: [...blockedBy]
    }));
  }

  private updateTodo(uri: string, update: (todo: SoloTodo) => SoloTodo): SoloTodo {
    const index = this.todos.findIndex((todo) => todo.uri === uri);
    if (index === -1) {
      throw new Error(`missing todo ${uri}`);
    }
    this.todos[index] = update(this.todos[index]);
    return this.todos[index];
  }
}

describe("Solo planning state", () => {
  it("locates a selected scratchpad and asks on ambiguous selections", async () => {
    const selected = {
      uri: "solo://proj/11/scratchpad/selected",
      projectId: 11,
      title: "Selected",
      content: "",
      selected: true
    };
    const client = new FakeSoloClient({
      scratchpads: [
        selected,
        {
          uri: "solo://proj/11/scratchpad/other",
          projectId: 11,
          title: "Other",
          content: ""
        }
      ]
    });

    await expect(locateSelectedScratchpad(client, 11)).resolves.toEqual(selected);

    const ambiguous = new FakeSoloClient({
      scratchpads: [
        { ...selected, selected: false },
        {
          uri: "solo://proj/11/scratchpad/other",
          projectId: 11,
          title: "Other",
          content: ""
        }
      ]
    });
    await expect(locateSelectedScratchpad(ambiguous, 11)).rejects.toBeInstanceOf(
      AmbiguousScratchpadSelectionError
    );
  });

  it("creates missing plan todos, tags them, comments associations, and stores state in the scratchpad", async () => {
    const client = new FakeSoloClient({
      scratchpads: [
        {
          uri: "solo://proj/11/scratchpad/solo-orchestration-a--50",
          projectId: 11,
          title: "Solo orchestration",
          content: "Working notes"
        }
      ]
    });

    const result = await createOrUpdateScratchpadPlan(client, 11, {
      id: "plan-a",
      title: "Plan A",
      decisions: ["Use Solo durable state"],
      todos: [
        { key: "design", title: "Design planning state" },
        { key: "dispatch", title: "Dispatch workers", dependsOn: ["design"] }
      ]
    });

    expect(result.todos.map((todo) => todo.created)).toEqual([true, true]);
    expect(client.createTodoCalls).toBe(2);
    expect(client.commentsAdded).toBe(2);
    expect(client.todos[0].tags).toEqual([
      "solist:plan:plan-a",
      "solist:scratchpad:solo://proj/11/scratchpad/solo-orchestration-a--50",
      "solist:todo-key:design"
    ]);
    expect(client.todos[1].blockedBy).toEqual([client.todos[0].uri]);
    expect(client.scratchpads[0].content).toContain("<!-- solist:plan-state");
    expect(client.scratchpads[0].content).toContain('"design"');
    expect(client.scratchpads[0].content).toContain(client.todos[0].uri);
  });

  it("is idempotent when the scratchpad already records associations", async () => {
    const client = new FakeSoloClient({
      scratchpads: [
        {
          uri: "solo://proj/11/scratchpad/solo-orchestration-a--50",
          projectId: 11,
          title: "Solo orchestration",
          content: "Working notes"
        }
      ]
    });
    const plan = {
      id: "plan-a",
      title: "Plan A",
      todos: [{ key: "design", title: "Design planning state" }]
    };

    await createOrUpdateScratchpadPlan(client, 11, plan);
    const second = await createOrUpdateScratchpadPlan(client, 11, plan);

    expect(second.todos).toHaveLength(1);
    expect(second.todos[0].created).toBe(false);
    expect(client.createTodoCalls).toBe(1);
    expect(client.commentsAdded).toBe(1);
    expect(client.todos[0].comments).toHaveLength(1);
  });

  it("adopts existing todos by durable tags when scratchpad associations are absent", async () => {
    const scratchpadUri = "solo://proj/11/scratchpad/solo-orchestration-a--50";
    const client = new FakeSoloClient({
      scratchpads: [
        {
          uri: scratchpadUri,
          projectId: 11,
          title: "Solo orchestration",
          content: ""
        }
      ],
      todos: [
        {
          uri: "solo://proj/11/todo/existing",
          projectId: 11,
          title: "Existing design todo",
          tags: [
            "solist:plan:plan-a",
            `solist:scratchpad:${scratchpadUri}`,
            "solist:todo-key:design"
          ],
          comments: [],
          blockedBy: []
        }
      ]
    });

    const result = await createOrUpdateScratchpadPlan(client, 11, {
      id: "plan-a",
      title: "Plan A",
      todos: [{ key: "design", title: "Design planning state" }]
    });

    expect(result.todos[0].created).toBe(false);
    expect(client.createTodoCalls).toBe(0);
    expect(client.commentsAdded).toBe(1);
    expect(result.state.todoAssociations.design).toBe("solo://proj/11/todo/existing");
  });
});

