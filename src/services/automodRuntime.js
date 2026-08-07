import { ModerationService } from './moderation/moderationService.js';
export * from './automodEngine.js';

const originalTimeout = ModerationService.timeoutUser.bind(ModerationService);
const originalKick = ModerationService.kickUser.bind(ModerationService);
const originalBan = ModerationService.banUser.bind(ModerationService);

ModerationService.timeoutUser = (args) => originalTimeout({ ...args, member: args.member?.member ?? args.member });
ModerationService.kickUser = (args) => originalKick({ ...args, member: args.member?.member ?? args.member });
ModerationService.banUser = (args) => originalBan(args);
