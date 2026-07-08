// Single source of truth for the "Rede Pecas - WhatsApp Conversation Script"
// client-facing document. Both the PDF and the spreadsheet (XLSX, opens
// straight in Google Sheets) are rendered from this same data by
// generate-flow-doc.js, so the two never drift apart.
//
// Block types used inside a stage's `blocks` array:
//   { t: 'system',  text }              - a message the bot sends
//   { t: 'customer', text }             - the customer's typed reply / button tap
//   { t: 'buttons', items: [...] }      - quick-reply buttons attached to the message above
//   { t: 'note', text }                 - a branch, error case, or alternate path
//   { t: 'subhead', text }              - a sub-section heading within a stage (e.g. "Path A - VIN")
//   { t: 'table', headers: [...], rows: [[...]] } - tabular reference info

export const meta = {
  docTitle: 'Rede Pecas',
  docSubtitle: 'WhatsApp Conversation Script',
  intro: [
    'Every message the bot can send, start to finish, in the order the pipeline can trigger it.',
    'Example customer used throughout: Vivek, driving a Honda Accord 2003.',
  ],
  legend: [
    ['System', 'A message the bot sends to the customer over WhatsApp.'],
    ['Customer', "The customer's typed reply or button tap."],
    ['Buttons shown', 'Quick-reply buttons attached to the message above it.'],
    ['Note', 'A branch, error case, or alternate path worth knowing about.'],
  ],
};

export const stages = [
  {
    id: 'STAGE 01',
    title: 'First Time Interaction with User',
    intro: 'A brand-new phone number. Runs once per customer. NIF is the only optional branch.',
    blocks: [
      { t: 'customer', text: 'Hi' },
      { t: 'system', text: "Welcome to Rede Pecas!\nWe're Angola's auto parts marketplace - we find the right parts for your vehicle as fast as possible.\nTo help you better, let's set up your profile quickly.\nWhat's your name?" },
      { t: 'customer', text: 'Vivek Makwana' },
      { t: 'system', text: 'Nice to meet you, Vivek!\nDo you have a NIF (tax ID) to include on invoices?\n(useful if you\'re buying on behalf of a company)' },
      { t: 'buttons', items: ['Yes, I have a NIF', 'No, thanks'] },
      { t: 'customer', text: 'No, thanks' },
      { t: 'system', text: "What's your preferred delivery address?\nExample: Bairro Morro Bento, Rua da Samba, No 12, Luanda\n(reply \"skip\" if you'd rather provide it when placing an order)" },
      { t: 'customer', text: 'Bairro Morro Bento, Rua da Samba, No 45, Luanda' },
      { t: 'system', text: "Profile created successfully, Vivek!\nNext time you message us, I'll already recognize you.\nNow I need to identify your vehicle. Pick an option:" },
      { t: 'buttons', items: ['I have the VIN', 'Send a photo', 'Manual entry'] },
      { t: 'note', text: 'If "Yes, I have a NIF": the bot asks "Great! Type your NIF number", then continues straight to the address question above.' },
      { t: 'note', text: 'If the customer goes quiet mid-registration and returns later: "Let\'s continue your registration!" followed by the exact question for whichever step they stalled on.' },
    ],
  },
  {
    id: 'STAGE 02',
    title: 'Vehicle Attachment with User',
    intro: 'Three possible paths, all converging on the same Yes/No confirmation.',
    blocks: [
      { t: 'subhead', text: 'Path A - VIN' },
      { t: 'customer', text: 'I have the VIN' },
      { t: 'system', text: 'Perfect! Send the chassis number (VIN) - 17 characters, found on the vehicle document or stamped on the chassis itself.' },
      { t: 'customer', text: '1HGCM82633A004352' },
      { t: 'system', text: 'Identifying the vehicle from the chassis number...' },
      { t: 'system', text: "Vehicle identified!\nHonda Accord 2003 - 2.3L - Gasoline - Sedan\nIs this your car?" },
      { t: 'buttons', items: ["Yes, that's it", 'No, different car'] },
      { t: 'note', text: 'If the VIN isn\'t recognized by NHTSA: "I couldn\'t identify that chassis number. Let\'s fill in the details manually..." then continues straight into Path C below.' },

      { t: 'subhead', text: 'Path B - Document photo' },
      { t: 'customer', text: 'Send a photo' },
      { t: 'system', text: 'Perfect! Take a clear photo of the vehicle document (registration/title) and send it here.' },
      { t: 'customer', text: '[sends photo of the registration document]' },
      { t: 'system', text: "Got the photo. Reading the document's data..." },
      { t: 'system', text: 'Data read from the document!\nHonda Accord 2003 - 2.3L - Gasoline - Plate: LD-45-67-AB\nIs this your car?' },
      { t: 'buttons', items: ["Yes, that's it", 'No, different car'] },
      { t: 'note', text: 'Error cases, each offering "I don\'t have it" to drop to manual entry: couldn\'t download the image - error processing the document - image isn\'t a vehicle document - photo unreadable (lighting/focus/framing tips) - essential data (make/model) missing.' },

      { t: 'subhead', text: 'Path C - Manual entry' },
      { t: 'customer', text: 'Manual entry' },
      { t: 'system', text: "No problem! Let's fill in the details manually.\nWhat's the make of the vehicle?\nExample: Toyota, Mercedes, Volvo..." },
      { t: 'customer', text: 'Honda' },
      { t: 'system', text: 'Honda\nNow tell me the model of the vehicle.\nExample: Hilux, L200, Actros, Sprinter, Ranger...' },
      { t: 'customer', text: 'Accord' },
      { t: 'system', text: 'Honda Accord\nWhat year is the vehicle?\nExample: 2015, 2018, 2020...' },
      { t: 'customer', text: '2003' },
      { t: 'system', text: "Honda Accord 2003\nWhat's the engine number? (optional)\nThis number matters for engine parts, servicing, and maintenance.\nIf you don't know it, reply \"don't know\" and we'll continue." },
      { t: 'customer', text: "don't know" },
      { t: 'system', text: "Great! I've saved your vehicle's details:\nHonda Accord 2003\nNow tell me which part you need and I'll search our stock." },
      { t: 'note', text: 'An invalid year (not 4 digits, or out of the 1980-current+1 range) gets "Invalid year. Please enter the year with 4 digits." and re-asks the same step.' },
    ],
  },
  {
    id: 'STAGE 03',
    title: 'First Vehicle Ever vs. Ask-a-Part',
    intro: 'On a "Yes", the bot checks whether this is the customer\'s very first confirmed vehicle ever, or a returning/second one.',
    blocks: [
      { t: 'subhead', text: 'First vehicle ever' },
      { t: 'system', text: "You're registered with Rede Pecas, Vivek!\nHonda Accord 2003\nHow can I help you today? Tell me which part you need and I'll search our stock right away." },
      { t: 'buttons', items: ['Add vehicle'] },

      { t: 'subhead', text: 'Already registered before - lighter prompt, no "profile created" copy' },
      { t: 'system', text: 'Perfect!\nNow tell me which part you need for your Honda Accord 2003.\nExample: "oil filter", "brake pads", "timing belt"...' },
      { t: 'buttons', items: ['Add vehicle'] },

      { t: 'subhead', text: '2+ confirmed vehicles on file - vehicle picker runs first' },
      { t: 'system', text: 'Which of your vehicles is this for?\n1. Honda Accord 2003\n2. Toyota Hilux 2018' },
      { t: 'customer', text: '1' },
      { t: 'note', text: 'An unrecognized reply gets "I didn\'t get that. Reply with just the vehicle\'s number." and re-asks. Once resolved, the same "tell me what part you need" message above fires for the chosen vehicle.' },
    ],
  },
  {
    id: 'STAGE 04',
    title: 'AI Agent & Stock Search',
    intro: 'Everything past this point is free text, handled by Claude - gated so the AI is never the customer\'s first reply.',
    blocks: [
      { t: 'customer', text: 'oil filter' },
      { t: 'system', text: 'One moment, checking our stock for you...' },
      { t: 'system', text: 'I found 2 option(s) for oil filter for your Honda Accord 2003:\n\n1. Bosch Oil Filter\n   Ref: OF-4471\n   Price: 8,500 Kz\n   Stock: 6 unit(s)\n   Delivery: 24h\n   Supplier: AutoPecas Luanda\n\n2. Mann Oil Filter\n   Ref: OF-9012\n   Price: 11,200 Kz\n   Stock: 3 unit(s)\n   Delivery: 48h\n\nReply with the number of the option you prefer.' },
      { t: 'customer', text: '1' },
      { t: 'note', text: 'If make/model/year is missing and there\'s no vehicle on file, the AI asks ONE short clarifying question first - e.g. "timing belt for a Toyota Hilux" gets asked for the year, since it\'s critical for compatibility.' },

      { t: 'subhead', text: 'No stock found - offers the waitlist instead' },
      { t: 'system', text: "Unfortunately I couldn't find that part in stock right now. I can register your request and notify you when it's available. Want me to do that?" },
      { t: 'customer', text: 'Yes' },
      { t: 'system', text: "Perfect! I'll let you know as soon as [part] is available." },
      { t: 'note', text: 'A "No" reply gets "No problem!" instead. Weeks later, when that exact item is restocked, every waitlisted customer gets: "Good news! [part] is back in stock. Want to place an order?"' },
    ],
  },
  {
    id: 'STAGE 05',
    title: 'Order Confirmation & Payment Method',
    intro: "The chosen option resolves against the numbered list saved a moment ago - a stale reply can't create a duplicate order.",
    blocks: [
      { t: 'system', text: 'Order confirmed!\n\nAttached is your proforma invoice for:\nBosch Oil Filter\n\nReference: RP-2026-00482\nTotal: 8,500 Kz\nValid for: 48 hours\n\nAfter payment, send the proof here in this conversation.' },
      { t: 'system', text: '[PDF attachment: Proforma_RP-2026-00482.pdf]' },
      { t: 'system', text: 'How would you like to pay?\n\nOrder: RP-2026-00482\nAmount: 8,500 Kz\n\nChoose an option:' },
      { t: 'buttons', items: ['Transfer / Deposit', 'Multicaixa Express', 'Mobile POS / Cash'] },
      { t: 'customer', text: 'Transfer / Deposit' },
      { t: 'system', text: 'Would you prefer a bank transfer or a bank deposit?' },
      { t: 'buttons', items: ['Transfer', 'Deposit'] },
      { t: 'customer', text: 'Transfer' },
      { t: 'system', text: 'Bank Transfer\n\nBank: BFA / BAI / BIC (your choice)\nIBAN: AO06 0040 0000 XXXX XXXX XXXX X\nAccount holder: Rede Pecas, Lda\nAmount: 8,500 Kz\nReference: RP-2026-00482 (required)\n\nAfter the transfer, send the proof here (photo or PDF).' },
      { t: 'subhead', text: 'Other payment options (same structure, different details)' },
      {
        t: 'table',
        headers: ['Button', 'Sub-choice', 'Proof?', 'What differs'],
        rows: [
          ['Transfer / Deposit', 'Deposit', 'Yes', 'Account number instead of IBAN; "write the reference on the receipt" instead of "required on the transfer"'],
          ['Multicaixa Express', '(none - direct)', 'Yes', 'Phone number + amount; asks for a screenshot of the confirmation'],
          ['Mobile POS / Cash', 'POS (card)', 'No', 'No proof step - staff is alerted directly to bring the terminal'],
          ['Mobile POS / Cash', 'Cash on delivery', 'No', 'No proof step - staff is alerted that the customer pays cash on delivery'],
        ],
      },
    ],
  },
  {
    id: 'STAGE 06',
    title: 'Payment Proof & Staff Handoff',
    intro: 'Only for the two proof-required methods above - the in-person pair skips straight to the staff alert.',
    blocks: [
      { t: 'customer', text: '[sends photo of the proof]' },
      { t: 'system', text: 'Proof received!\n\nMethod: Bank Transfer\nOrder: RP-2026-00482\n\nOur team will verify the payment and issue the invoice shortly.\nUsually takes under 30 minutes during business hours.' },
      { t: 'subhead', text: 'Internal message - sent only to the staff phone, never the customer' },
      { t: 'system', text: 'PAYMENT PROOF RECEIVED\n\nOrder: RP-2026-00482\nMethod: Bank Transfer\nAmount: 8,500 Kz\nCustomer: 919313090929\n\nGo to the panel to verify and approve:\nhttps://app.redepecas.ao/admin/orders' },
      { t: 'note', text: 'For the in-person pair (POS / cash), the customer never sees a proof-request message - staff gets "IN-PERSON PAYMENT REQUESTED" directly, with an instruction to bring the terminal or collect cash on delivery.' },
    ],
  },
  {
    id: 'STAGE 07',
    title: 'Staff Approval / Rejection',
    intro: 'Happens outside WhatsApp, in the admin panel. Only the outcome reaches the customer.',
    blocks: [
      { t: 'subhead', text: 'Approved' },
      { t: 'system', text: 'Official AGT Invoice Issued!\nYour payment has been validated and the official invoice is now attached.\nThanks for shopping with Rede Pecas!' },
      { t: 'system', text: '[attachment: Invoice_RP-2026-00482.pdf]' },
      { t: 'note', text: 'In parallel, the supplier (not the customer) is notified to prepare the item for pickup - a failed send here is logged and never blocks the customer-facing approval.' },

      { t: 'subhead', text: 'Rejected' },
      { t: 'system', text: 'Your order RP-2026-00482 was rejected.\nReason: payment proof not confirmed or invalid.\nIf you think this is a mistake, reply here and a staff member will help you.' },
      { t: 'note', text: 'No refund-tracking state exists by design - a rejection is message-only; "refunded within 3-5 business days" is conveyed verbally by staff if it applies, not by a bot message.' },
    ],
  },
  {
    id: 'STAGE 08',
    title: 'Returning-Customer Paths',
    intro: 'What a bare "Hi" does depends on two facts checked fresh every message: is the profile complete, and is there a confirmed vehicle on file.',
    blocks: [
      { t: 'subhead', text: 'Profile complete + vehicle on file - the common case' },
      { t: 'customer', text: 'Hi' },
      { t: 'system', text: 'Hey again, Vivek! Welcome back to Rede Pecas.' },
      { t: 'system', text: 'Perfect!\nNow tell me which part you need for your Honda Accord 2003.\nExample: "oil filter", "brake pads", "timing belt"...' },
      { t: 'buttons', items: ['Add vehicle'] },

      { t: 'subhead', text: 'Profile complete, no vehicle ever confirmed - confirmed vehicles never expire' },
      { t: 'customer', text: 'Hi' },
      { t: 'system', text: 'Welcome back, Vivek!\nI still need to identify your vehicle. Pick an option:' },
      { t: 'buttons', items: ['I have the VIN', 'Send a photo', 'Manual entry'] },

      { t: 'subhead', text: 'Adding another vehicle mid-conversation' },
      { t: 'note', text: 'Available any time after the first vehicle is confirmed - the button always sits alongside the ask-a-part prompt, and typing "add vehicle" free-text does exactly the same thing.' },
      { t: 'customer', text: 'Add vehicle' },
      { t: 'system', text: "Let's identify your new vehicle. Pick an option:" },
      { t: 'buttons', items: ['I have the VIN', 'Send a photo', 'Manual entry'] },
      { t: 'note', text: 'Repeats Stage 2 in full - the previous vehicle is never touched.' },
      { t: 'customer', text: 'I have the VIN' },
      { t: 'system', text: 'Perfect! Send the chassis number (VIN) - 17 characters, found on the vehicle document or stamped on the chassis itself.' },
      { t: 'customer', text: '1HGCM82633A004352' },
      { t: 'system', text: 'Identifying the vehicle from the chassis number...' },
      { t: 'system', text: "Vehicle identified!\nHonda Accord 2003 - 2.9L - Gasoline - Coupe\nIs this your car?" },
      { t: 'buttons', items: ["Yes, that's it", 'No, different car'] },
      { t: 'customer', text: "Yes, that's it" },
      { t: 'system', text: 'Perfect!\nNow tell me which part you need for your Honda Accord 2003.\nExample: "oil filter", "brake pads", "timing belt"...' },
      { t: 'buttons', items: ['Add vehicle'] },
      { t: 'note', text: 'No "profile created"/"registered" message this time - that copy is reserved for the customer\'s very first vehicle ever (see Stage 3).' },
      { t: 'customer', text: 'Oil filter' },
      { t: 'system', text: 'Which of your vehicles is this for?\n1. Honda Accord 2003\n2. Honda Accord 2003' },
      { t: 'customer', text: '1' },
      { t: 'system', text: 'Perfect!\nNow tell me which part you need for your Honda Accord 2003.' },
      { t: 'note', text: 'Now that 2 vehicles are on file, every future search resolves which one it\'s for first - see the vehicle-picker in Stage 3.' },

      { t: 'note', text: 'A bare greeting ("Hi" / "Hello" / "Hey") at any point always resets to the "what part do you need" question, even mid-conversation with the AI agent.' },
    ],
  },
];
