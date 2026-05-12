export type CoverCacheMigrationResult = {
  oldDir: string;
  newDir: string;
  copiedFiles: number;
  skippedFiles: number;
  updatedCoverRows: number;
  warnings: string[];
  errors: string[];
};

export type SetCoverCacheDirectoryRequest = {
  directory: string | null;
  migrate: boolean;
};
