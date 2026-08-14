import { invoke } from "@tauri-apps/api/core";
import type {
  CreateHermesTask,
  CreateHermesTaskResponse,
  HermesBoard,
  HermesBoardsResponse,
  HermesConnectionStatus,
  HermesHomeChannel,
  HermesProfilesResponse,
  HermesTaskDetail,
  HermesWorkerLog,
} from "./types";

export const connectManagedHermes = () =>
  invoke<HermesConnectionStatus>("hermes_connect_managed");

export const connectDiscoveredHermes = () =>
  invoke<HermesConnectionStatus>("hermes_connect_discovered");

export const connectExistingHermes = (url: string, token: string) =>
  invoke<HermesConnectionStatus>("hermes_connect_existing", { url, token });

export const disconnectHermes = () =>
  invoke<HermesConnectionStatus>("hermes_disconnect");

export const getHermesConnectionStatus = (board?: string) =>
  invoke<HermesConnectionStatus>("hermes_connection_status", { board: board || null });

export const subscribeHermesEvents = (board: string, since: number) =>
  invoke<void>("hermes_subscribe_events", { board, since });

export const unsubscribeHermesEvents = () =>
  invoke<void>("hermes_unsubscribe_events");

export const listHermesBoards = () =>
  invoke<HermesBoardsResponse>("hermes_list_boards");

export const listHermesProfiles = () =>
  invoke<HermesProfilesResponse>("hermes_list_profiles");

export const getHermesBoard = (board: string, includeArchived: boolean) =>
  invoke<HermesBoard>("hermes_get_board", { board, includeArchived });

export const getHermesTask = (board: string, taskId: string) =>
  invoke<HermesTaskDetail>("hermes_get_task", { board, taskId });

export const getHermesTaskLog = (board: string, taskId: string) =>
  invoke<HermesWorkerLog>("hermes_get_task_log", { board, taskId });

export const addHermesComment = (board: string, taskId: string, body: string) =>
  invoke<{ ok: boolean }>("hermes_add_comment", { board, taskId, body });

export const createHermesTask = (board: string, payload: CreateHermesTask, targetStatus: string) =>
  invoke<CreateHermesTaskResponse>("hermes_create_task", { board, payload, targetStatus });

export const patchHermesTaskStatus = (board: string, taskId: string, status: string) =>
  invoke<unknown>("hermes_patch_task", { board, taskId, status });

export const addHermesTaskLink = (board: string, parentId: string, childId: string) =>
  invoke<unknown>("hermes_add_task_link", { board, parentId, childId });

export const removeHermesTaskLink = (board: string, parentId: string, childId: string) =>
  invoke<unknown>("hermes_remove_task_link", { board, parentId, childId });

export const listHermesHomeChannels = (board: string, taskId: string) =>
  invoke<{ home_channels: HermesHomeChannel[] }>("hermes_home_channels", { board, taskId });

export const setHermesHomeSubscription = (board: string, taskId: string, platform: string, subscribed: boolean) =>
  invoke<unknown>("hermes_set_home_subscription", { board, taskId, platform, subscribed });

export const uploadHermesAttachment = (board: string, taskId: string, path: string) =>
  invoke<unknown>("hermes_upload_attachment", { board, taskId, path });

export const downloadHermesAttachment = (board: string, attachmentId: number, destination: string) =>
  invoke<void>("hermes_download_attachment", { board, attachmentId, destination });

export const deleteHermesAttachment = (board: string, attachmentId: number) =>
  invoke<unknown>("hermes_delete_attachment", { board, attachmentId });
