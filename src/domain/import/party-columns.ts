/**
 * The customer and supplier spreadsheet contracts.
 *
 * One list of shared columns, because a party is a party: the same name,
 * phone, GSTIN and address fields on both sides of the khata. Each kind adds
 * what only it has — a credit limit for a customer, payment terms for a
 * supplier.
 *
 * The opening balance is the one column with a direction, and it follows the
 * way every billing app shows it:
 *   customer  positive = they owe the shop (to receive), negative = advance held
 *   supplier  positive = the shop owes them (to pay),    negative = advance paid
 * It is create-only: re-importing a party list must not add the balance again.
 */
import {
  defineColumns,
  type CellValue,
  type ColumnDefinition,
  type ColumnSet,
  type ParsedRow,
} from './columns.js';

const NAME: ColumnDefinition = {
  key: 'name',
  header: 'Name',
  type: 'text',
  required: true,
  synonyms: [
    'partyname',
    'party',
    'nameofparty',
    'customername',
    'customer',
    'suppliername',
    'supplier',
    'vendor',
    'vendorname',
    'ledgername',
    'accountname',
    'firmname',
    'businessname',
    'companyname',
  ],
};

const SHARED_AFTER_NAME: readonly ColumnDefinition[] = [
  {
    key: 'phone',
    header: 'Phone',
    type: 'phone',
    required: false,
    synonyms: [
      'phoneno',
      'phonenumber',
      'mobile',
      'mobileno',
      'mobilenumber',
      'contact',
      'contactno',
      'contactnumber',
      'whatsapp',
      'whatsappno',
      'whatsappnumber',
      'telephone',
      'tel',
      'cell',
    ],
  },
  {
    key: 'email',
    header: 'Email',
    type: 'email',
    required: false,
    synonyms: ['emailid', 'emailaddress', 'mail', 'mailid'],
  },
  {
    key: 'gstin',
    header: 'GSTIN',
    type: 'gstin',
    required: false,
    synonyms: ['gstno', 'gstnumber', 'gstinno', 'gstinuin', 'gst', 'gstregistrationno', 'taxid'],
  },
  {
    key: 'stateCode',
    header: 'State',
    type: 'state',
    required: false,
    synonyms: ['statecode', 'statename', 'placeofsupply', 'pos', 'billingstate'],
  },
  {
    key: 'addressLine1',
    header: 'Address',
    type: 'text',
    required: false,
    synonyms: ['address1', 'addressline1', 'billingaddress', 'fulladdress', 'street', 'addr'],
  },
  {
    key: 'addressLine2',
    header: 'Address line 2',
    type: 'text',
    required: false,
    synonyms: ['address2', 'area', 'locality', 'landmark'],
  },
  {
    key: 'city',
    header: 'City',
    type: 'text',
    required: false,
    synonyms: ['town', 'cityname', 'district'],
  },
  {
    key: 'pincode',
    header: 'Pincode',
    type: 'text',
    required: false,
    synonyms: ['pin', 'pinno', 'zip', 'zipcode', 'postalcode', 'postcode'],
  },
];

const OPENING: readonly ColumnDefinition[] = [
  {
    key: 'openingBalance',
    header: 'Opening balance',
    type: 'signedMoney',
    required: false,
    createOnly: true,
    synonyms: [
      'openingbal',
      'opbal',
      'balance',
      'balancedue',
      'currentbalance',
      'closingbalance',
      'outstanding',
      'dueamount',
      'amountdue',
      'receivable',
      'toreceive',
      'payable',
      'topay',
      'balancepayable',
    ],
  },
  {
    key: 'openingDate',
    header: 'Opening date',
    type: 'date',
    required: false,
    createOnly: true,
    // Vyapar writes "Opening Date (dd/MM/yyyy)".
    synonyms: [
      'openingdateddmmyyyy',
      'openingbalancedate',
      'asofdate',
      'asondate',
      'balancedate',
      'opdate',
    ],
  },
];

const NOTES: ColumnDefinition = {
  key: 'notes',
  header: 'Notes',
  type: 'text',
  required: false,
  synonyms: ['remarks', 'remark', 'comment', 'comments', 'note'],
};

export const CUSTOMER_COLUMNS: readonly ColumnDefinition[] = [
  NAME,
  ...SHARED_AFTER_NAME,
  {
    key: 'creditLimit',
    header: 'Credit limit',
    type: 'money',
    required: false,
    synonyms: ['limit', 'maxcredit', 'creditlimitamount'],
  },
  ...OPENING,
  NOTES,
];

export const SUPPLIER_COLUMNS: readonly ColumnDefinition[] = [
  NAME,
  ...SHARED_AFTER_NAME,
  {
    key: 'paymentTermsDays',
    header: 'Payment terms (days)',
    type: 'days',
    required: false,
    synonyms: ['paymentterms', 'creditdays', 'creditperiod', 'duedays', 'termsdays', 'paymentdays'],
  },
  ...OPENING,
  NOTES,
];

export const CUSTOMER_COLUMN_SET = defineColumns(CUSTOMER_COLUMNS);
export const SUPPLIER_COLUMN_SET = defineColumns(SUPPLIER_COLUMNS);

/**
 * Converts one party row into stored values.
 *
 * Settles what crosses columns: a missing state is read off the GSTIN (its
 * first two digits are the state code, and that decides CGST+SGST versus
 * IGST on every bill), and an opening date without a balance is meaningless.
 */
export function parsePartyRow(
  set: ColumnSet,
  cells: readonly CellValue[],
  map: Record<string, number>,
): ParsedRow {
  const parsed = set.parseRow(cells, map);
  const values = { ...parsed.values };
  const notes = [...parsed.notes];

  // A registered party's state is the one its GSTIN was issued in; the
  // database refuses any other. A file that disagrees (a branch address, a
  // typo in the State column) keeps the row, with the GSTIN's state and a note.
  const gstin = values['gstin'];
  if (typeof gstin === 'string') {
    const fromGstin = gstin.slice(0, 2);
    const given = values['stateCode'];
    if (typeof given === 'string' && given !== fromGstin) {
      notes.push(`State ${given} changed to ${fromGstin}, the state the GSTIN is registered in`);
    }
    values['stateCode'] = fromGstin;
  }
  if (values['openingBalance'] === 0) values['openingBalance'] = null;
  if (values['openingDate'] && !values['openingBalance']) values['openingDate'] = null;

  return { values, errors: parsed.errors, notes };
}
