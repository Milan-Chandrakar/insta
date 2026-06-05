const FESTIVAL_SLOTS_2026 = [
  {
    date: '2026-01-14',
    festival: 'Makar Sankranti',
    deity: 'surya',
    storySeed: 'sunrise, gratitude, new beginnings, harvest blessings'
  },
  {
    date: '2026-01-23',
    festival: 'Vasant Panchami',
    deity: 'saraswati',
    storySeed: 'wisdom, veena, yellow tones, learning, creative blessing'
  },
  {
    date: '2026-02-15',
    festival: 'Maha Shivratri',
    deity: 'shiva',
    storySeed: 'meditation, tandava, Kailash stillness, surrender'
  },
  {
    date: '2026-03-04',
    festival: 'Holi',
    deity: 'krishna',
    storySeed: 'rang, leela, Radha-Krishna joy, spring devotion'
  },
  {
    date: '2026-03-19',
    festival: 'Chaitra Navratri Begins',
    deity: 'durga',
    storySeed: 'shakti, protection, nine forms of the goddess, renewal'
  },
  {
    date: '2026-03-26',
    festival: 'Ram Navami',
    deity: 'rama',
    storySeed: 'Ayodhya, maryada, dharma, divine birth of Rama'
  },
  {
    date: '2026-04-02',
    festival: 'Hanuman Jayanti',
    deity: 'hanuman',
    storySeed: 'bhakti, strength, seva, Sankat Mochan courage'
  },
  {
    date: '2026-04-19',
    festival: 'Akshaya Tritiya',
    deity: 'lakshmi-vishnu',
    storySeed: 'abundance, auspicious beginnings, grace, prosperity'
  },
  {
    date: '2026-04-30',
    festival: 'Narasimha Jayanti',
    deity: 'narasimha',
    storySeed: 'protection, Prahlad, divine intervention, fearless faith'
  },
  {
    date: '2026-07-29',
    festival: 'Guru Purnima',
    deity: 'guru',
    storySeed: 'guru kripa, discipleship, wisdom, spiritual lineage'
  },
  {
    date: '2026-09-04',
    festival: 'Krishna Janmashtami',
    deity: 'krishna',
    storySeed: 'Makhan Chor, flute, Gokul, midnight birth, leela'
  },
  {
    date: '2026-09-14',
    festival: 'Ganesh Chaturthi',
    deity: 'ganesha',
    storySeed: 'new beginnings, remover of obstacles, modak, devotion'
  },
  {
    date: '2026-10-11',
    festival: 'Sharad Navratri Begins',
    deity: 'durga',
    storySeed: 'Navdurga, shakti, garba spirit, spiritual battle and grace'
  },
  {
    date: '2026-10-20',
    festival: 'Dussehra',
    deity: 'rama',
    storySeed: 'victory of dharma, Ravana vadha, triumph of good'
  },
  {
    date: '2026-11-08',
    festival: 'Diwali',
    deity: 'lakshmi-rama',
    storySeed: 'deep, homecoming, Lakshmi blessings, light over darkness'
  },
  {
    date: '2026-11-09',
    festival: 'Govardhan Puja',
    deity: 'krishna',
    storySeed: 'Govardhan, protection, Annakut, divine shelter'
  },
  {
    date: '2026-12-20',
    festival: 'Gita Jayanti',
    deity: 'krishna',
    storySeed: 'Kurukshetra, Bhagavad Gita wisdom, duty, inner clarity'
  }
];

const WEEKDAY_THEMES = {
  0: {
    deity: 'surya',
    label: 'Sunday Surya slot',
    storySeed: 'sunrise discipline, radiant blessings, energy, gratitude'
  },
  1: {
    deity: 'shiva',
    label: 'Monday Shiva slot',
    storySeed: 'Shiv bhakti, stillness, Kailash, surrender, inner peace'
  },
  2: {
    deity: 'hanuman',
    label: 'Tuesday Hanuman slot',
    storySeed: 'strength, seva, Sankat Mochan, courage, protection'
  },
  3: {
    deity: 'krishna',
    label: 'Wednesday Krishna slot',
    storySeed: 'flute, leela, Vrindavan, sweetness, divine play'
  },
  4: {
    deity: 'vishnu-guru',
    label: 'Thursday Vishnu/Guru slot',
    storySeed: 'guru kripa, Vishnu protection, dharma, satsang'
  },
  5: {
    deity: 'lakshmi-radha',
    label: 'Friday Lakshmi/Radha slot',
    storySeed: 'grace, prosperity, devotion, beauty, soft bhakti'
  },
  6: {
    deity: 'shani-hanuman',
    label: 'Saturday Shani/Hanuman slot',
    storySeed: 'karma, relief, endurance, prayer, protective devotion'
  }
};

function toDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getFestivalSlots2026() {
  return FESTIVAL_SLOTS_2026.map((item) => ({ ...item }));
}

export function resolveDevotionalThemeForDate(date) {
  const dayKey = toDayKey(date);
  const festival = FESTIVAL_SLOTS_2026.find((item) => item.date === dayKey);
  if (festival) {
    return {
      source: 'festival',
      label: festival.festival,
      deity: festival.deity,
      storySeed: festival.storySeed,
      date: festival.date
    };
  }

  const weekday = date.getDay();
  const theme = WEEKDAY_THEMES[weekday] || WEEKDAY_THEMES[1];
  return {
    source: 'weekday',
    label: theme.label,
    deity: theme.deity,
    storySeed: theme.storySeed,
    date: dayKey
  };
}
