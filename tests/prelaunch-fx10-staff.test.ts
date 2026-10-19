// Final review, fx-10 (customer-wording-4): the order confirmation tells a customer who wants to
// pay by transfer to type “staff”. Copied with its quotation marks, straight or curly, the word
// still reaches a person before any AI is asked.
import { describe, expect, it } from 'vitest';
import { isStaffRequest } from '../src/domain/disclosure';

describe('fx-10: the quoted word from the confirmation reaches staff', () => {
  it.each(['"staff"', '“staff”', '“Staff”', "'staff'", '‘staff’', '“عملہ”', '"عملہ"', '“staff”.'])(
    '“%s” asks for a person',
    (text) => {
      expect(isStaffRequest(text)).toBe(true);
    },
  );

  it.each([
    'staff ne kaha tha',
    '"staff" ne kaha tha',
    '2 biryani per person',
    '“staff” kab aayega',
  ])('“%s” does not', (text) => {
    expect(isStaffRequest(text)).toBe(false);
  });
});
