// Port of lib/core/utils/category_icons.dart.
//
// The stored value is the KEY on the left; the phone maps it to a Flutter
// icon. Here it maps to the Material Symbols ligature of the same glyph, so
// both ends show the same picture. Keys must stay identical to the Dart map —
// a key this app invents would render as the fallback on the phone.

export const ICON_GROUPS = [
  {
    label: 'General',
    icons: {
      category: 'category',
      other: 'more_horiz',
      star: 'star',
      tag: 'sell',
      flag: 'flag',
      bookmark: 'bookmark',
    },
  },
  {
    label: 'Food & drink',
    icons: {
      groceries: 'local_grocery_store',
      restaurant: 'restaurant',
      coffee: 'local_cafe',
      fastfood: 'fastfood',
      bakery: 'bakery_dining',
      liquor: 'local_bar',
      icecream: 'icecream',
    },
  },
  {
    label: 'Home & living',
    icons: {
      home: 'home',
      cleaning: 'cleaning_services',
      bed: 'bed',
      chair: 'chair',
      kitchen: 'kitchen',
      lightbulb: 'lightbulb',
      tools: 'handyman',
      yard: 'yard',
    },
  },
  {
    label: 'Bills & utilities',
    icons: {
      bills: 'receipt_long',
      utilities: 'bolt',
      water: 'water_drop',
      gas: 'local_fire_department',
      internet: 'wifi',
      phone: 'phone_iphone',
      tv: 'tv',
    },
  },
  {
    label: 'Transport',
    icons: {
      transport: 'directions_car',
      fuel: 'local_gas_station',
      parking: 'local_parking',
      bus: 'directions_bus',
      train: 'train',
      taxi: 'local_taxi',
      bike: 'pedal_bike',
      motorcycle: 'two_wheeler',
      flight: 'flight',
      travel: 'luggage',
    },
  },
  {
    label: 'Shopping',
    icons: {
      shopping: 'shopping_bag',
      clothing: 'checkroom',
      electronics: 'devices',
      beauty: 'spa',
      gift: 'card_giftcard',
      jewelry: 'diamond',
    },
  },
  {
    label: 'Health',
    icons: {
      health: 'local_hospital',
      pharmacy: 'medication',
      fitness: 'fitness_center',
      dental: 'medical_services',
    },
  },
  {
    label: 'Family',
    icons: {
      kids: 'child_care',
      pet: 'pets',
      school: 'school',
      education: 'menu_book',
    },
  },
  {
    label: 'Leisure',
    icons: {
      entertainment: 'movie',
      music: 'music_note',
      games: 'sports_esports',
      sports: 'sports_soccer',
      hobby: 'palette',
      book: 'auto_stories',
    },
  },
  {
    label: 'Money & work',
    icons: {
      salary: 'payments',
      savings: 'savings',
      investment: 'trending_up',
      bonus: 'emoji_events',
      refund: 'undo',
      bank: 'account_balance',
      work: 'work',
      card: 'credit_card',
    },
  },
  {
    label: 'Records',
    icons: {
      insurance: 'shield',
      tax: 'account_balance_wallet',
      subscription: 'subscriptions',
      document: 'description',
      car_repair: 'car_repair',
    },
  },
  {
    label: 'Inventory',
    icons: {
      box: 'inventory_2',
      bottle: 'local_drink',
      soap: 'soap',
      pest: 'pest_control',
    },
  },
];

export const ICON_KEYS = Object.fromEntries(
  ICON_GROUPS.flatMap((g) => Object.entries(g.icons)),
);

/** Material ligature for a stored key; falls back the way the phone does. */
export function glyphFor(key) {
  return ICON_KEYS[String(key || '').toLowerCase()] || 'category';
}

export function isKnownIcon(key) {
  return Boolean(ICON_KEYS[String(key || '').toLowerCase()]);
}

/** An <span> rendering the icon for a stored key. */
export function iconEl(key, { size = 18, className = '' } = {}) {
  const node = document.createElement('span');
  node.className = `micon ${className}`.trim();
  node.textContent = glyphFor(key);
  node.style.fontSize = `${size}px`;
  return node;
}
