import React from 'react';
import { useAppMetadataStore } from './appMetadataStore';
import { useConfigStore } from './configStore';
import { useUxStore } from './uxStore';
import { useProjectTabStore } from './projectTabStore';
import { useNavigationStore } from './navigationStore';
import { useWadExtractStore } from './wadExtractStore';
import { useArchiveEditStore } from './archiveEditStore';
import { useArchiveTabStore } from './archiveTabStore';
import { useWadExplorerStore } from './wadExplorerStore';
import { useChampionStore } from './championStore';
import { useModalStore } from './modalStore';
import { useFileEditorStore } from './fileEditorStore';
import { useNotificationStore } from './notificationStore';
import { useTransferStore } from './transferStore';

export {
  useAppMetadataStore,
  useConfigStore,
  useUxStore,
  useProjectTabStore,
  useNavigationStore,
  useWadExtractStore,
  useArchiveEditStore,
  useArchiveTabStore,
  useWadExplorerStore,
  useChampionStore,
  useModalStore,
  useNotificationStore,
  useFileEditorStore,
  useTransferStore,
};

export function AppProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}
