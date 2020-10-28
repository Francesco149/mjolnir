import { IProtection } from "./IProtection";
import { Mjolnir } from "../Mjolnir";
import { LogLevel, LogService } from "matrix-bot-sdk";
import { logMessage } from "../LogProxy";
import config from "../config";
import { isTrueJoinEvent } from "../utils";

const TIMESTAMP_THRESHOLD = 30000; // 30s out of phase
const banwords = [
  [["fuck"], ["john", "franc", "linux"]],
];

export class CustomSpam implements IProtection {

  private lastEvents: { [roomId: string]: { [userId: string]: { originServerTs: number, eventId: string }[] } } = {};

  constructor() {
  }

  public get name(): string {
    return 'CustomSpamProtection';
  }

  public async handleEvent(mjolnir: Mjolnir, roomId: string, event: any): Promise<any> {
    if (!this.lastEvents[roomId]) this.lastEvents[roomId] = {};

    const forRoom = this.lastEvents[roomId];
    if (!forRoom[event['sender']]) forRoom[event['sender']] = [];
    let forUser = forRoom[event['sender']];

    if ((new Date()).getTime() - event['origin_server_ts'] > TIMESTAMP_THRESHOLD) {
      LogService.warn("CustomSpam", `${event['event_id']} is more than ${TIMESTAMP_THRESHOLD}ms out of phase - rewriting event time to be 'now'`);
      event['origin_server_ts'] = (new Date()).getTime();
    }

    forUser.push({originServerTs: event['origin_server_ts'], eventId: event['event_id']});

    let ban = async (reason: string) => {
      if (!await mjolnir.client.userHasPowerLevelFor(event['sender'], roomId, "m.room.message", false)) {
        return;
      }
      await logMessage(LogLevel.WARN, "CustomSpam", `Muting ${event['sender']} in ${roomId} for ${reason}`, roomId);
      //await mjolnir.client.setUserPowerLevel(event['sender'], roomId, -1)
      await mjolnir.client.banUser(event['sender'], roomId, "spam");

      mjolnir.redactionHandler.addUser(event['sender']);

      if (!config.noop) {
        for (const eventId of forUser.map(e => e.eventId)) {
          await mjolnir.client.redactEvent(roomId, eventId, "spam");
        }
      } else {
        await logMessage(LogLevel.WARN, "CustomSpam", `Tried to redact messages for ${event['sender']} in ${roomId} but Mjolnir is running in no-op mode`, roomId);
      }

      this.lastEvents[roomId];
      forUser = forRoom[event['sender']] = [];
    };

    let checkBanWords = str => {
      let snorm = str.toLowerCase().replace(/ /g,'')
      let someWords = x => x.some((x) => snorm.indexOf(x) != -1);
      let banwordGroup = x => x.every(someWords);
      return banwords.some(banwordGroup);
    };

    const u = await mjolnir.client.getUserProfile(event['sender']);
    const names = [u['displayname'] || '', event['sender']];
    if (names.some(checkBanWords)) {
      ban(`name contains banwords`);
      return;
    }

    let messageCount = 0;
    let bigCount = 0;
    let mediaCount = 0;
    for (const prevEvent of forUser) {
      if ((new Date()).getTime() - prevEvent.originServerTs > 60000) continue; // not important
      messageCount++;
      const content = event['content'] || {};
      const msgtype = content['msgtype'] || 'm.text';
      const body = content['body'] || '';
      const formattedBody = content['formatted_body'] || '';
      const isMedia = msgtype === 'm.image' || msgtype === 'm.video' || formattedBody.toLowerCase().includes('<img');
      if (isMedia) ++mediaCount;
      if (body.length >= 400) ++bigCount;
    }

    messageCount >= 15 && await ban(`flood (${messageCount} messages in the last minute)`);
    bigCount >= 5    && await ban(`copypasta (${bigCount} big messages in the last minute)`);
    mediaCount >= 5  && await ban(`media flood (${mediaCount} media in the last minute)`);

    if (forUser.length > 30) {
      forUser.splice(0, forUser.length - 30 - 1);
    }
  }
}
