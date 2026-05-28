/**
 * Composition root — wires concrete adapters into application use-cases
 * and exposes them as a single typed `AppContainer` that the HTTP
 * server stashes on `app.locals.container`.
 *
 * Routes pull use-cases via `getContainer(req)` rather than newing them
 * inline. This is the seam that makes the codebase testable: tests
 * build their own container with in-memory ports.
 */
import { S3Client } from '@aws-sdk/client-s3';
import type { Request } from 'express';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';

import { PrismaTaskRepository } from './infrastructure/db/PrismaTaskRepository.js';
import { PrismaRecordingRepository } from './infrastructure/db/PrismaRecordingRepository.js';
import { S3Storage } from './infrastructure/storage/S3Storage.js';
import { FfmpegMediaPipeline } from './infrastructure/media/FfmpegMediaPipeline.js';
import { HttpWhisperGateway } from './infrastructure/whisper/HttpWhisperGateway.js';
import { OsTmpWorkspace } from './infrastructure/workspace/OsTmpWorkspace.js';
import { TaskWorker } from './infrastructure/tasks/TaskWorker.js';
import { RecordingPipelineHandler } from './infrastructure/tasks/handlers/RecordingPipelineHandler.js';

import { CompleteRecording } from './application/recordings/CompleteRecording.js';
import { RetryRecording } from './application/recordings/RetryRecording.js';
import { ProcessRecordingTask } from './application/tasks/ProcessRecordingTask.js';
import { ListTasks } from './application/tasks/ListTasks.js';
import { RetryTask } from './application/tasks/RetryTask.js';
import { CancelTask } from './application/tasks/CancelTask.js';

import type { TaskRepository } from './domain/ports/TaskRepository.js';
import type { RecordingRepository } from './domain/ports/RecordingRepository.js';
import type { StorageGateway } from './domain/ports/StorageGateway.js';

export type AppContainer = {
  storage: StorageGateway;
  tasks: TaskRepository;
  recordings: RecordingRepository;
  useCases: {
    completeRecording: CompleteRecording;
    retryRecording: RetryRecording;
    processRecordingTask: ProcessRecordingTask;
    listTasks: ListTasks;
    retryTask: RetryTask;
    cancelTask: CancelTask;
  };
  worker: TaskWorker;
};

export function buildContainer(): AppContainer {
  // ── S3 clients (internal vs public-for-signing) ─────────────────
  const s3Internal = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKey,
      secretAccessKey: config.s3.secretKey,
    },
  });
  const s3Public = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.publicEndpoint,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKey,
      secretAccessKey: config.s3.secretKey,
    },
  });

  // ── Adapters ────────────────────────────────────────────────────
  const storage = new S3Storage(s3Internal, s3Public, config.s3.bucket);
  const taskRepo = new PrismaTaskRepository(prisma);
  const recordingRepo = new PrismaRecordingRepository(prisma);
  const media = new FfmpegMediaPipeline();
  const whisper = new HttpWhisperGateway();
  const workspace = new OsTmpWorkspace();

  // ── Use-cases ───────────────────────────────────────────────────
  const completeRecording = new CompleteRecording(recordingRepo, taskRepo, storage);
  const retryRecording = new RetryRecording(recordingRepo, taskRepo);
  const processRecordingTask = new ProcessRecordingTask(
    taskRepo,
    recordingRepo,
    storage,
    media,
    whisper,
    workspace,
  );
  const listTasks = new ListTasks(taskRepo);
  const retryTask = new RetryTask(taskRepo);
  const cancelTask = new CancelTask(taskRepo);

  // ── Worker (registered handler per TaskType) ────────────────────
  const worker = new TaskWorker(taskRepo, {
    RECORDING_PIPELINE: new RecordingPipelineHandler(processRecordingTask),
  });

  return {
    storage,
    tasks: taskRepo,
    recordings: recordingRepo,
    useCases: {
      completeRecording,
      retryRecording,
      processRecordingTask,
      listTasks,
      retryTask,
      cancelTask,
    },
    worker,
  };
}

export function getContainer(req: Request): AppContainer {
  const c = (req.app.locals as { container?: AppContainer }).container;
  if (!c) throw new Error('container not initialized — server bootstrap missing');
  return c;
}
