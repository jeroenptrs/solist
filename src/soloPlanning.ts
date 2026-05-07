export interface SoloScratchpad {
  uri: string;
  projectId: number;
  title: string;
  content: string;
  selected?: boolean;
}

export interface SoloTodo {
  uri: string;
  projectId: number;
  title: string;
  body?: string;
  tags: string[];
  comments: SoloTodoComment[];
  blockedBy: string[];
}

export interface SoloTodoComment {
  body: string;
  createdAt?: string;
}

export interface SoloTodoDraft {
  key: string;
  title: string;
  body?: string;
  dependsOn?: string[];
  blockers?: string[];
}

export interface SoloPlanDraft {
  id: string;
  title: string;
  todos: SoloTodoDraft[];
  decisions?: string[];
}

export interface SoloPlanningState {
  schema: "solist.plan.v1";
  planId: string;
  planTitle: string;
  todoAssociations: Record<string, string>;
  decisions: string[];
}

export interface SoloPlanTodoResult {
  key: string;
  todo: SoloTodo;
  created: boolean;
}

export interface SoloPlanResult {
  scratchpad: SoloScratchpad;
  state: SoloPlanningState;
  todos: SoloPlanTodoResult[];
}

export interface SoloClient {
  listScratchpads(projectId: number): Promise<SoloScratchpad[]>;
  updateScratchpad(uri: string, patch: { content: string }): Promise<SoloScratchpad>;
  listTodos(projectId: number): Promise<SoloTodo[]>;
  createTodo(input: {
    projectId: number;
    title: string;
    body?: string;
    tags: string[];
  }): Promise<SoloTodo>;
  addTodoTags(uri: string, tags: string[]): Promise<SoloTodo>;
  addTodoComment(uri: string, body: string): Promise<SoloTodo>;
  setTodoBlockers(uri: string, blockedBy: string[]): Promise<SoloTodo>;
}

export class AmbiguousScratchpadSelectionError extends Error {
  constructor(public readonly candidates: SoloScratchpad[]) {
    super(
      `Multiple scratchpads are available: ${candidates.map((candidate) => candidate.uri).join(", ")}`
    );
    this.name = "AmbiguousScratchpadSelectionError";
  }
}

export class MissingScratchpadSelectionError extends Error {
  constructor(projectId: number) {
    super(`No scratchpad is available for project ${projectId}.`);
    this.name = "MissingScratchpadSelectionError";
  }
}

const STATE_START = "<!-- solist:plan-state";
const STATE_END = "solist:plan-state -->";

export async function locateSelectedScratchpad(
  client: SoloClient,
  projectId: number,
  selectedScratchpadUri?: string
): Promise<SoloScratchpad> {
  const scratchpads = await client.listScratchpads(projectId);

  if (selectedScratchpadUri) {
    const selected = scratchpads.find((scratchpad) => scratchpad.uri === selectedScratchpadUri);
    if (!selected) {
      throw new MissingScratchpadSelectionError(projectId);
    }
    return selected;
  }

  const selected = scratchpads.filter((scratchpad) => scratchpad.selected);
  if (selected.length === 1) {
    return selected[0];
  }
  if (selected.length > 1) {
    throw new AmbiguousScratchpadSelectionError(selected);
  }
  if (scratchpads.length === 1) {
    return scratchpads[0];
  }
  if (scratchpads.length === 0) {
    throw new MissingScratchpadSelectionError(projectId);
  }
  throw new AmbiguousScratchpadSelectionError(scratchpads);
}

export async function createOrUpdateScratchpadPlan(
  client: SoloClient,
  projectId: number,
  plan: SoloPlanDraft,
  options: { selectedScratchpadUri?: string } = {}
): Promise<SoloPlanResult> {
  const scratchpad = await locateSelectedScratchpad(client, projectId, options.selectedScratchpadUri);
  const todos = await client.listTodos(projectId);
  const existingState = parsePlanningState(scratchpad.content, plan.id);
  const state: SoloPlanningState = {
    schema: "solist.plan.v1",
    planId: plan.id,
    planTitle: plan.title,
    todoAssociations: { ...existingState?.todoAssociations },
    decisions: mergeUnique([...(existingState?.decisions ?? []), ...(plan.decisions ?? [])])
  };

  const results: SoloPlanTodoResult[] = [];
  const resolved = new Map<string, SoloTodo>();

  for (const draft of plan.todos) {
    const todo = await ensurePlanTodo(client, projectId, scratchpad, plan.id, draft, state, todos);
    resolved.set(draft.key, todo.todo);
    results.push(todo);
  }

  for (const draft of plan.todos) {
    const todo = resolved.get(draft.key);
    if (!todo) {
      continue;
    }
    const blockerUris = resolveBlockerUris(draft, state, resolved);
    if (!sameSet(todo.blockedBy, blockerUris)) {
      const updated = await client.setTodoBlockers(todo.uri, blockerUris);
      resolved.set(draft.key, updated);
      const result = results.find((candidate) => candidate.key === draft.key);
      if (result) {
        result.todo = updated;
      }
    }
  }

  const updatedScratchpad = await client.updateScratchpad(scratchpad.uri, {
    content: writePlanningState(scratchpad.content, state)
  });

  return {
    scratchpad: updatedScratchpad,
    state,
    todos: results
  };
}

function parsePlanningState(content: string, planId: string): SoloPlanningState | undefined {
  const start = content.indexOf(STATE_START);
  const end = content.indexOf(STATE_END, start + STATE_START.length);
  if (start === -1 || end === -1) {
    return undefined;
  }

  const json = content.slice(start + STATE_START.length, end).trim();
  try {
    const parsed = JSON.parse(json) as Partial<SoloPlanningState>;
    if (parsed.schema !== "solist.plan.v1" || parsed.planId !== planId) {
      return undefined;
    }
    return {
      schema: "solist.plan.v1",
      planId: parsed.planId,
      planTitle: parsed.planTitle ?? planId,
      todoAssociations: parsed.todoAssociations ?? {},
      decisions: parsed.decisions ?? []
    };
  } catch {
    return undefined;
  }
}

function writePlanningState(content: string, state: SoloPlanningState): string {
  const serialized = `${STATE_START}\n${JSON.stringify(state, null, 2)}\n${STATE_END}`;
  const start = content.indexOf(STATE_START);
  const end = content.indexOf(STATE_END, start + STATE_START.length);
  if (start === -1 || end === -1) {
    return `${content.trimEnd()}\n\n${serialized}\n`;
  }
  return `${content.slice(0, start)}${serialized}${content.slice(end + STATE_END.length)}`;
}

async function ensurePlanTodo(
  client: SoloClient,
  projectId: number,
  scratchpad: SoloScratchpad,
  planId: string,
  draft: SoloTodoDraft,
  state: SoloPlanningState,
  existingTodos: SoloTodo[]
): Promise<SoloPlanTodoResult> {
  const tags = planTags(planId, scratchpad.uri, draft.key);
  const associatedUri = state.todoAssociations[draft.key];
  const existing =
    existingTodos.find((todo) => todo.uri === associatedUri) ??
    existingTodos.find((todo) => tags.every((tag) => todo.tags.includes(tag)));

  if (existing) {
    state.todoAssociations[draft.key] = existing.uri;
    const missingTags = tags.filter((tag) => !existing.tags.includes(tag));
    const tagged = missingTags.length > 0 ? await client.addTodoTags(existing.uri, missingTags) : existing;
    if (!hasAssociationComment(tagged, planId, scratchpad.uri, draft.key)) {
      const commented = await client.addTodoComment(tagged.uri, associationComment(planId, scratchpad.uri, draft.key));
      return { key: draft.key, todo: commented, created: false };
    }
    return { key: draft.key, todo: tagged, created: false };
  }

  const created = await client.createTodo({
    projectId,
    title: draft.title,
    body: draft.body,
    tags
  });
  const commented = await client.addTodoComment(created.uri, associationComment(planId, scratchpad.uri, draft.key));
  state.todoAssociations[draft.key] = commented.uri;
  existingTodos.push(commented);
  return { key: draft.key, todo: commented, created: true };
}

function planTags(planId: string, scratchpadUri: string, todoKey: string): string[] {
  return [`solist:plan:${planId}`, `solist:scratchpad:${scratchpadUri}`, `solist:todo-key:${todoKey}`];
}

function associationComment(planId: string, scratchpadUri: string, todoKey: string): string {
  return `Solist association: plan=${planId}; scratchpad=${scratchpadUri}; todoKey=${todoKey}`;
}

function hasAssociationComment(todo: SoloTodo, planId: string, scratchpadUri: string, todoKey: string): boolean {
  const expected = associationComment(planId, scratchpadUri, todoKey);
  return todo.comments.some((comment) => comment.body === expected);
}

function resolveBlockerUris(
  draft: SoloTodoDraft,
  state: SoloPlanningState,
  resolved: Map<string, SoloTodo>
): string[] {
  const keys = [...(draft.dependsOn ?? []), ...(draft.blockers ?? [])];
  return mergeUnique(
    keys.map((keyOrUri) => resolved.get(keyOrUri)?.uri ?? state.todoAssociations[keyOrUri] ?? keyOrUri)
  );
}

function mergeUnique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

