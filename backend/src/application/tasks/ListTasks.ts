import type {
  ListTasksFilter,
  ListTasksResult,
  TaskRepository,
} from '../../domain/ports/TaskRepository.js';

/**
 * Read-only listing for the admin "Worker" UI. Defaults to a recent
 * window with no status filter.
 */
export class ListTasks {
  constructor(private readonly tasks: TaskRepository) {}

  execute(filter: ListTasksFilter = {}): Promise<ListTasksResult> {
    return this.tasks.list({
      limit: 50,
      ...filter,
    });
  }
}
