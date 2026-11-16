import { describe, expect, test } from 'vitest';
import {
  exampleTrackedLink,
  type TrackingForm,
  trackingProblems,
} from './tracking-settings';

const VALID: TrackingForm = {
  publicUrl: '',
  campaignUrl: 'https://campaign.sianext.com',
  conversionEvent: 'app_open',
  conversionWindowDays: '7',
};

const fieldsOf = (form: TrackingForm) =>
  trackingProblems(form).map((problem) => problem.field);

describe('trackingProblems', () => {
  test('a valid form has no problems', () => {
    expect(trackingProblems(VALID)).toEqual([]);
    expect(
      trackingProblems({ ...VALID, campaignUrl: '', conversionEvent: '' })
    ).toEqual([]);
  });

  test('http on a public host is a problem', () => {
    expect(
      fieldsOf({ ...VALID, publicUrl: 'http://dash.example.com' })
    ).toEqual(['publicUrl']);
    expect(
      fieldsOf({ ...VALID, campaignUrl: 'http://localhost:3000' })
    ).toEqual([]);
  });

  test('a path is a problem', () => {
    expect(
      fieldsOf({ ...VALID, campaignUrl: 'https://campaign.sianext.com/x' })
    ).toEqual(['campaignUrl']);
  });

  test('window 0 and 31 are problems', () => {
    for (const days of ['0', '31', '1.5', '']) {
      expect(fieldsOf({ ...VALID, conversionWindowDays: days })).toEqual([
        'conversionWindowDays',
      ]);
    }
    for (const days of ['1', '30']) {
      expect(fieldsOf({ ...VALID, conversionWindowDays: days })).toEqual([]);
    }
  });
});

describe('exampleTrackedLink', () => {
  test('example link uses the campaign url', () => {
    expect(exampleTrackedLink('https://campaign.sianext.com')).toBe(
      'https://campaign.sianext.com/marketing/r/…'
    );
    expect(exampleTrackedLink(null)).toBeNull();
  });
});
