export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type ResourceKind = 'page' | 'block' | 'database' | 'data_source';

export interface ResourceRef {
  kind: ResourceKind;
  id: string;
}

export interface BlockTodoProfile {
  kind: 'blocks';
  pageId: string;
  defaultOwner: string;
  containers: Record<string, {
    id: string;
    layout: 'dated' | 'sections' | 'flat';
    section?: string;
    sectionLabels?: string[];
    dateOrder?: 'descending' | 'preserve';
  }>;
  backlogContainer?: string;
  backlogContainers?: Record<string, string>;
  logBuckets: string[];
}

export interface DatabaseTodoProfile {
  kind: 'database';
  dataSourceId: string;
  titleProperty: string;
  statusProperty: string;
  statusType: 'status' | 'select' | 'checkbox';
  pendingValue: string | boolean;
  doneValue: string | boolean;
  dateProperty?: string;
  ownerProperty?: string;
  ownerType?: 'people' | 'select';
  owners: Record<string, string>;
}

export interface Profile {
  key: string;
  label: string;
  aliases: string[];
  repositories: string[];
  credentialRef: string;
  connection: {
    botId: string;
    workspaceId?: string;
  };
  roots: ResourceRef[];
  protected: ResourceRef[];
  canonical: Record<string, ResourceRef>;
  timezone: string;
  todos: BlockTodoProfile | DatabaseTodoProfile | null;
}

export interface Registry {
  version: 1;
  profiles: string[];
}

export interface CredentialFile {
  version: 1;
  connections: Record<string, { token: string }>;
}
