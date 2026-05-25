import { describe, expect, it } from 'vitest';
import { AirPlayMdnsAdvertiser } from './AirPlayMdnsAdvertiser';

type PacketFactory = {
  createPacket: (advertisement: {
    name: string;
    address: string;
    mac: string;
    port: number;
    model: string;
  }, ttl: number) => Buffer;
};

describe('AirPlayMdnsAdvertiser', () => {
  it('advertises both RAOP and AirPlay service records for iOS discovery', () => {
    const advertiser = new AirPlayMdnsAdvertiser() as unknown as PacketFactory;
    const packet = advertiser.createPacket({
      name: 'ECHO Next (AirPlay)',
      address: '192.168.31.214',
      mac: '60:CF:84:CB:1E:D1',
      port: 6000,
      model: 'ECHO-Next-AirPlay-Spike',
    }, 120);
    const payload = packet.toString('utf8');

    expect(packet.readUInt16BE(6)).toBe(9);
    expect(payload).toContain('_raop');
    expect(payload).toContain('_airplay');
    expect(payload).toContain('deviceid=60:CF:84:CB:1E:D1');
  });
});
