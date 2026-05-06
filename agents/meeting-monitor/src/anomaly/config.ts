import { JurisdictionConfig } from './types';

export const BOZEMAN_CONFIG: JurisdictionConfig = {
  name: 'Bozeman City Commission',
  quorumSize: 3,
  totalMembers: 5,
  emergencyNoticeHours: 48,
  minutesDeadlineDays: 14,
  controversialTopics: [
    'annexation',
    'rezoning',
    'zone map amendment',
    'tax increment',
    'tif',
    'budget',
    'millage',
    'eminent domain',
    'police',
    'housing',
    'affordable housing',
    'homeless',
    'shelter',
  ],
};

export function getJurisdictionConfig(name?: string): JurisdictionConfig {
  if (!name || name.toLowerCase().includes('bozeman')) {
    return BOZEMAN_CONFIG;
  }
  return BOZEMAN_CONFIG;
}
