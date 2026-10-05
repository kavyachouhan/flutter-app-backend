/**
 * GST state codes to state names.
 *
 * The first two digits of a GSTIN are the state code, and "place of supply"
 * on a B2B invoice is required to name the state, not the number. Keeping the
 * table here rather than on the device means a state rename or a new union
 * territory is a server deploy, not an app-store release.
 *
 * Codes 25 and 28 are retained deliberately: 25 (Daman and Diu) and 28 (the
 * undivided Andhra Pradesh) are no longer issued, but GSTINs carrying them
 * are still on file and still have to print.
 */

export const STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Other Country',
});

/**
 * The state's name, or null when the code is unknown.
 *
 * Null rather than the raw code: a bare "41" beside "Place of supply" reads
 * as a mistake, whereas an omitted line reads as a field that does not apply.
 */
export function stateNameFor(code: string | null | undefined): string | null {
  if (!code) return null;
  return STATE_NAMES[code] ?? null;
}
