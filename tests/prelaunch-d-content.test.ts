import { describe, expect, it } from 'vitest';
import { captionText, gatewayEventSchema, locationText } from '../src/shared/whatsapp';

// F01: the wording both WhatsApp routes use when a caption or a location pin reaches the bot.
describe('shared caption and location wording', () => {
  it('keeps the caption as the customer text and marks what came with it', () => {
    expect(captionText('2 biryani please', 'photo')).toBe('2 biryani please (sent with a photo)');
    expect(captionText('  menu  ', 'video')).toBe('menu (sent with a video)');
    const long = captionText('x'.repeat(5000), 'document');
    expect(long).toHaveLength(4000);
    expect(long.endsWith('(sent with a document)')).toBe(true);
  });

  it('turns a location pin into the place and coordinates, without inventing a link', () => {
    expect(
      locationText({
        latitude: 31.5204,
        longitude: 74.3587,
        name: 'Liberty  Market',
        address: 'Gulberg III, Lahore',
      }),
    ).toBe('Location shared: Liberty Market, Gulberg III, Lahore (31.5204, 74.3587)');
    expect(locationText({ latitude: 33.68441234, longitude: 73.0479 })).toBe(
      'Location shared: (33.684412, 73.0479)',
    );
    expect(locationText({ name: 'F-7 Markaz', address: 'F-7 Markaz' })).toBe(
      'Location shared: F-7 Markaz',
    );
    expect(locationText({ latitude: 200, longitude: 74, name: 'Home' })).toBe(
      'Location shared: Home',
    );
    expect(locationText({ latitude: Number.NaN, longitude: 74 })).toBeUndefined();
    expect(locationText({})).toBeUndefined();
    expect(
      locationText({ latitude: 31.5, longitude: 74.3, name: 'x'.repeat(1000) })!.length,
    ).toBeLessThan(400);
  });

  it('produces text the gateway event schema accepts', () => {
    const text = captionText('y'.repeat(4100), 'photo');
    expect(gatewayEventSchema.shape.text.safeParse(text).success).toBe(true);
  });
});
