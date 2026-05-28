import type { Task, TaskType } from '../../domain/entities/Task.js';

export interface TaskHandler {
  execute(task: Task): Promise<void>;
}

export type TaskHandlerRegistry = Partial<Record<TaskType, TaskHandler>>;
