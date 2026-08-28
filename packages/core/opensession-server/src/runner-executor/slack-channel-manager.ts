/**
 * Slack Channel Manager for Mission Control.
 *
 * Manages Slack project channels, creation, and updates.
 * Each project gets a dedicated channel for coordinated work.
 */

import { createFeltDB, getTelemetryClient } from "@feltdb/core";
import { randomUUIDv7 } from "bun";
import type { MissionControlProject } from "./mission-control-project";

/**
 * Slack project channel record.
 */
export interface SlackProjectChannel {
  id: string;
  projectId: string;
  slackWorkspaceId: string;
  channelId: string;
  channelName: string;
  topic?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stored row for Slack channels.
 */
interface StoredSlackChannel {
  id: string;
  projectId: string;
  slackWorkspaceId: string;
  channelId: string;
  channelName: string;
  topic?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Slack Channel Manager Interface.
 */
export interface SlackChannelManagerInterface {
  // Channel CRUD
  createChannel(channel: SlackProjectChannel): Promise<void>;
  getChannel(id: string): Promise<SlackProjectChannel | undefined>;
  getChannelByProject(projectId: string): Promise<SlackProjectChannel | undefined>;
  getChannelBySlackId(channelId: string): Promise<SlackProjectChannel | undefined>;
  updateChannel(channel: SlackProjectChannel): Promise<void>;
  deleteChannel(id: string): Promise<void>;
  listChannels(slackWorkspaceId: string): Promise<SlackProjectChannel[]>;

  // Channel setup
  generateChannelName(projectName: string): string;
}

/**
 * Open or create a Slack channel manager.
 */
export function openSlackChannelManager(
  path: string,
): SlackChannelManagerInterface {
  const telemetry = getTelemetryClient();
  telemetry.disable();

  const db = createFeltDB({
    path,
    namespace: "mission-control-slack-channels",
  });

  const CHANNELS_COLLECTION = "slack_project_channels";

  return {
    async createChannel(channel: SlackProjectChannel): Promise<void> {
      const row: StoredSlackChannel = {
        id: channel.id,
        projectId: channel.projectId,
        slackWorkspaceId: channel.slackWorkspaceId,
        channelId: channel.channelId,
        channelName: channel.channelName,
        topic: channel.topic,
        description: channel.description,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
      };

      await db.transaction((tx) => {
        tx.collection<StoredSlackChannel>(CHANNELS_COLLECTION).set(
          channel.id,
          row,
        );
      });
    },

    async getChannel(id: string): Promise<SlackProjectChannel | undefined> {
      const row = await db
        .collection<StoredSlackChannel>(CHANNELS_COLLECTION)
        .get(id);
      if (!row) return undefined;
      return {
        id: row.id,
        projectId: row.projectId,
        slackWorkspaceId: row.slackWorkspaceId,
        channelId: row.channelId,
        channelName: row.channelName,
        topic: row.topic,
        description: row.description,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async getChannelByProject(
      projectId: string,
    ): Promise<SlackProjectChannel | undefined> {
      const rows = await db
        .collection<StoredSlackChannel>(CHANNELS_COLLECTION)
        .find({ projectId });

      if (rows.length === 0) return undefined;
      const row = rows[0];
      return {
        id: row.id,
        projectId: row.projectId,
        slackWorkspaceId: row.slackWorkspaceId,
        channelId: row.channelId,
        channelName: row.channelName,
        topic: row.topic,
        description: row.description,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async getChannelBySlackId(
      channelId: string,
    ): Promise<SlackProjectChannel | undefined> {
      const rows = await db
        .collection<StoredSlackChannel>(CHANNELS_COLLECTION)
        .find({ channelId });

      if (rows.length === 0) return undefined;
      const row = rows[0];
      return {
        id: row.id,
        projectId: row.projectId,
        slackWorkspaceId: row.slackWorkspaceId,
        channelId: row.channelId,
        channelName: row.channelName,
        topic: row.topic,
        description: row.description,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async updateChannel(channel: SlackProjectChannel): Promise<void> {
      const row: StoredSlackChannel = {
        id: channel.id,
        projectId: channel.projectId,
        slackWorkspaceId: channel.slackWorkspaceId,
        channelId: channel.channelId,
        channelName: channel.channelName,
        topic: channel.topic,
        description: channel.description,
        createdAt: channel.createdAt,
        updatedAt: new Date().toISOString(),
      };

      await db.transaction((tx) => {
        tx.collection<StoredSlackChannel>(CHANNELS_COLLECTION).set(
          channel.id,
          row,
        );
      });
    },

    async deleteChannel(id: string): Promise<void> {
      await db.transaction((tx) => {
        tx.collection<StoredSlackChannel>(CHANNELS_COLLECTION).delete(id);
      });
    },

    async listChannels(
      slackWorkspaceId: string,
    ): Promise<SlackProjectChannel[]> {
      const rows = await db
        .collection<StoredSlackChannel>(CHANNELS_COLLECTION)
        .find({ slackWorkspaceId });

      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        slackWorkspaceId: row.slackWorkspaceId,
        channelId: row.channelId,
        channelName: row.channelName,
        topic: row.topic,
        description: row.description,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },

    generateChannelName(projectName: string): string {
      // Convert project name to valid Slack channel name
      // Valid: lowercase, alphanumeric, hyphens, underscores
      // Max 80 chars
      return `project-${projectName
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, "-")
        .replace(/-+/g, "-")
        .substring(0, 70)}`;
    },
  };
}
