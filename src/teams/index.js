// Team channels: address resolution, the team log and read marks. docs/spec/teams.md.
// `sbb move` resets a moved brain's marks through `resetTeamMarks` here; nothing outside
// src/teams/ writes ~/.sbb/teams.
export {
  ALL_CHANNEL, allChannels, channelForBrain, channelName, checkChannel, isChannelAddress,
  resolveChannel, teamMembers,
} from './channels.js';
export { appendTeamLog, listTeamLogIds, readTeamLog, teamLogPath, teamsDir } from './log.js';
export { readMark, readMarkPath, resetTeamMarks, unreadTeamLog, writeMark } from './marks.js';
export { channelRole, sendToChannel } from './fanout.js';
