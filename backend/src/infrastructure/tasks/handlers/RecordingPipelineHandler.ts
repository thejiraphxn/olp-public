import type { Task } from '../../../domain/entities/Task.js';
import type { ProcessRecordingTask } from '../../../application/tasks/ProcessRecordingTask.js';
import type { TaskHandler } from '../TaskHandler.js';

export class RecordingPipelineHandler implements TaskHandler {
  constructor(private readonly useCase: ProcessRecordingTask) {}

  execute(task: Task): Promise<void> {
    return this.useCase.execute(task);
  }
}
