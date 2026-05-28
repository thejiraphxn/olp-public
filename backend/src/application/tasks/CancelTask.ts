import type { TaskRepository } from '../../domain/ports/TaskRepository.js';
import { isTerminal } from '../../domain/entities/Task.js';

export class CancelTask {
  constructor(private readonly tasks: TaskRepository) {}

  async execute(taskId: string, reason?: string): Promise<void> {
    const task = await this.tasks.findById(taskId);
    if (!task) throw new Error('task not found');
    if (isTerminal(task.status)) return; // no-op
    await this.tasks.cancel(taskId, reason);
  }
}
