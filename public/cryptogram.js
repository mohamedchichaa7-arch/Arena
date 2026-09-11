/* global fbAuth */
(() => {
'use strict';

// ── URL / Session ────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = sessionStorage.getItem('arena-name') || 'Player';
const isPvP = !!roomId;

// ── DOM refs ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const statusEl        = $('status');
const roomBadgeEl     = $('roomBadge');
const btnBack         = $('btnBack');
const btnToggleSidebar= $('btnToggleSidebar');
const btnRules        = $('btnRules');
const playerListEl    = $('playerList');
const playerCountEl   = $('playerCount');
const sidebarTitleEl  = $('sidebarTitle');
const sidebar         = $('sidebar');

// Screens
const screenHub       = $('screen-hub');
const screenConfig    = $('screen-config');
const screenPvPLobby  = $('screen-pvp-lobby');
const screenPuzzle    = $('screen-puzzle');

// Hub
const btnSoloMode     = $('btnSoloMode');
const btnPvPMode      = $('btnPvPMode');
const btnDailyChallenge=$('btnDailyChallenge');
const dailyStreak     = $('dailyStreak');
const dailyStatus     = $('dailyStatus');
const dailyCard       = $('dailyCard');
const btnHubStats     = $('btnHubStats');
const btnHubLeaderboard=$('btnHubLeaderboard');

// Config
const diffPills       = $('diffPills');
const catPills        = $('catPills');
const btnBackFromConfig=$('btnBackFromConfig');
const btnStartSolo    = $('btnStartSolo');

// PvP lobby
const pvpLobbyStatus  = $('pvpLobbyStatus');
const pvpConfig       = $('pvpConfig');
const pvpDiffPills    = $('pvpDiffPills');
const pvpCategory     = $('pvpCategory');
const btnStartPvP     = $('btnStartPvP');

// Puzzle
const phCategory      = $('phCategory');
const phDifficulty    = $('phDifficulty');
const timerDisplay    = $('timerDisplay');
const mistakeCountEl  = $('mistakeCount');
const hintCountEl     = $('hintCount');
const hintStatWrap    = $('hintStatWrap');
const hintCountBtnEl  = $('hintCountBtn');
const btnPause        = $('btnPause');
const puzzleGrid      = $('puzzleGrid');
const authorHintBar   = $('authorHintBar');
const letterTrayEl    = $('letterTray');
const btnHint         = $('btnHint');
const btnFreq         = $('btnFreq');
const freqPanel       = $('freqPanel');
const freqBarsEl      = $('freqBars');
const btnCloseFreq    = $('btnCloseFreq');
const hiddenInput     = $('hiddenInput');

// Opponent panel
const opponentPanel   = $('opponentPanel');
const oppAvatar       = $('oppAvatar');
const oppName         = $('oppName');
const oppSub          = $('oppSub');
const oppBarFill      = $('oppBarFill');
const oppBarLabel     = $('oppBarLabel');
const oppHintFlag     = $('oppHintFlag');
const oppMiniGrid     = $('oppMiniGrid');

// Overlays
const resultOverlay   = $('resultOverlay');
const resultBanner    = $('resultBanner');
const resultQuoteReveal=$('resultQuoteReveal');
const resultMeta      = $('resultMeta');
const resultFunfact   = $('resultFunfact');
const resultStatsGrid = $('resultStatsGrid');
const resultShareRow  = $('resultShareRow');
const resultActionsRow= $('resultActionsRow');
const btnShareResult  = $('btnShareResult');

const pauseOverlay    = $('pauseOverlay');
const btnResume       = $('btnResume');
const btnQuitToHub    = $('btnQuitToHub');

const statsOverlay    = $('statsOverlay');
const statsContent    = $('statsContent');
const btnCloseStats   = $('btnCloseStats');

const lbOverlay       = $('lbOverlay');
const lbContent       = $('lbContent');
const lbTabs          = $('lbTabs');
const btnCloseLb      = $('btnCloseLb');

const rulesOverlay    = $('rulesOverlay');
const btnCloseRules   = $('btnCloseRules');
const urgencyEdge     = $('urgencyEdge');

// ── Constants ────────────────────────────────────────────────────
const DIFF_NAMES  = {e:'Easy', n:'Normal', h:'Hard', x:'Expert'};
const DIFF_MULT   = {e:1, n:1.8, h:3, x:5};
const DIFF_PAR    = {e:180, n:300, h:480, x:900}; // par times in seconds
const DIFF_HINTS  = {e:5, n:3, h:2, x:1};
const DIFF_REVEAL = {e:10, n:6, h:3, x:1};
const CAT_ICONS   = {all:'🌟',movie:'🎬',history:'🌍',humor:'😂',motivation:'💪',philosophy:'🧠',music:'🎵',tunisian:'🇹🇳'};
const SAVE_KEY    = 'cryptogram_save';
const STATS_KEY   = 'cg_stats';
const DAILY_KEY   = 'cg_daily';

// ── Quote database ───────────────────────────────────────────────
// [text, author, category, difficulty, optional_fun_fact]
// difficulty: e=easy(30-50), n=normal(50-80), h=hard(80-120), x=expert(120-180)
const CG_QUOTES = [
  // ── EASY ──────────────────────────────────────────────────────
  ["Be yourself; everyone else is taken.","Oscar Wilde","humor","e","Wilde made this quip in conversation, and it spread worldwide after his death."],
  ["All that glitters is not gold.","Shakespeare, The Merchant of Venice","movie","e","The original line from 1596 reads 'All that glisters is not gold.'"],
  ["Do or do not, there is no try.","Yoda, Star Wars","movie","e","Yoda says this to Luke Skywalker in The Empire Strikes Back (1980)."],
  ["The best revenge is massive success.","Frank Sinatra","motivation","e"],
  ["It always seems impossible until it's done.","Nelson Mandela","motivation","e","Mandela spent 27 years in prison before leading South Africa to democracy."],
  ["Time you enjoy wasting is not wasted time.","Bertrand Russell","philosophy","e"],
  ["Float like a butterfly, sting like a bee.","Muhammad Ali","history","e","Ali's trainer Bundini Brown first coined this phrase."],
  ["Well-behaved women rarely make history.","Laurel Thatcher Ulrich","history","e","Ulrich wrote this in a 1976 academic article about Puritan funeral sermons."],
  ["Life is what happens while you make plans.","John Lennon","music","e","Lennon included a version of this line in the song Beautiful Boy (1980)."],
  ["Happiness is not something readymade.","Dalai Lama","philosophy","e"],
  ["The pen is mightier than the sword.","Edward Bulwer-Lytton","history","e","From the 1839 play Richelieu; Or the Conspiracy."],
  ["A smile is the best makeup a girl can wear.","Marilyn Monroe","humor","e"],
  ["Give me liberty, or give me death!","Patrick Henry","history","e","Henry delivered this speech in 1775, sparking the American Revolution."],
  ["With great power comes great responsibility.","Stan Lee, Spider-Man","movie","e","This phrase first appeared in Amazing Fantasy #15 (1962)."],
  ["Every cloud has a silver lining.","English Proverb","motivation","e"],
  ["I feel the need, the need for speed.","Top Gun","movie","e","Said by Maverick and Goose in the 1986 film."],
  ["A camel is a horse designed by committee.","Alec Issigonis","humor","e","Issigonis, who designed the Mini, said this to mock design-by-committee."],
  ["Truth is rarely pure and never simple.","Oscar Wilde","philosophy","e","From The Importance of Being Earnest (1895)."],
  ["The unexamined life is not worth living.","Socrates","philosophy","e","Socrates said this at his trial, choosing death over exile."],
  ["He who laughs last laughs best.","Proverb","humor","e"],
  ["Not all those who wander are lost.","J.R.R. Tolkien","motivation","e","From the poem All that is gold does not glitter in The Fellowship of the Ring."],
  ["Failure is only the opportunity to begin again.","Henry Ford","motivation","e"],
  ["An eye for an eye makes the whole world blind.","Mahatma Gandhi","history","e","This paraphrase is widely attributed to Gandhi."],
  ["Music is the shorthand of emotion.","Leo Tolstoy","music","e"],
  ["Patience is the key to paradise.","Islamic Proverb","tunisian","e","In Arabic: Assabr miftah al-faraj."],
  ["The eye cannot see its own eyelash.","Arabic Proverb","tunisian","e","Means we are blind to our own faults."],
  ["A good friend is worth more than silver or gold.","Tunisian Proverb","tunisian","e"],
  ["In the beginning was the Word.","The Bible, John 1:1","history","e"],
  ["To boldly go where no man has gone before.","Star Trek","movie","e","The original TV series opening narration from 1966."],
  ["Why so serious? Let's put a smile on that face.","The Dark Knight","movie","e","Said by Heath Ledger's Joker in the 2008 film."],
  ["I'm going to make him an offer he can't refuse.","The Godfather","movie","e","Said by Marlon Brando as Don Corleone in 1972."],
  ["Keep your friends close, and your enemies closer.","The Godfather Part II","movie","e"],
  ["You talking to me? There is no one else here.","Taxi Driver, paraphrase","movie","e","De Niro improvised the original 'You talkin' to me?' scene."],
  ["The stuff that dreams are made of.","The Maltese Falcon","movie","e","Said by Humphrey Bogart in the 1941 classic."],
  ["After all, tomorrow is another day.","Gone with the Wind","movie","e","Scarlett O'Hara's famous closing line from the 1939 film."],
  ["May the odds be ever in your favor.","The Hunger Games","movie","e"],
  ["No, I am your father. Search your feelings.","Star Wars, paraphrase","movie","e","The line is 'No, I am your father' from The Empire Strikes Back."],
  ["Carpe diem. Seize the day, boys.","Dead Poets Society","movie","e","Robin Williams delivers this as Professor Keating in the 1989 film."],
  ["Life is like a box of chocolates.","Forrest Gump","movie","e","Forrest's mama told him this in the 1994 film."],
  ["I am inevitable. And I am Iron Man.","Avengers: Endgame","movie","e","Tony Stark's final words in the 2019 film."],

  // ── NORMAL ────────────────────────────────────────────────────
  ["Two things are infinite: the universe and human stupidity.","Albert Einstein","humor","n","Einstein may have added: 'And I'm not sure about the universe.'"],
  ["You only live once, but if you do it right, once is enough.","Mae West","humor","n"],
  ["In three words I can sum up everything about life: it goes on.","Robert Frost","philosophy","n"],
  ["I am not a product of my circumstances; I am a product of my decisions.","Stephen Covey","motivation","n","From The 7 Habits of Highly Effective People."],
  ["The only way to do great work is to love what you do.","Steve Jobs","motivation","n","From Jobs' 2005 Stanford commencement address."],
  ["I have a dream that one day this nation will rise up and live out its creed.","Martin Luther King Jr.","history","n","Delivered at the March on Washington, August 28, 1963."],
  ["Ask not what your country can do for you, ask what you can do for your country.","John F. Kennedy","history","n","From JFK's inaugural address on January 20, 1961."],
  ["We shall fight on the beaches, and we shall never surrender.","Winston Churchill","history","n","Delivered to the House of Commons on June 4, 1940."],
  ["The most common form of despair is not being who you truly are.","Søren Kierkegaard","philosophy","n"],
  ["In the middle of every difficulty lies opportunity.","Albert Einstein","motivation","n"],
  ["An investment in knowledge always pays the best interest.","Benjamin Franklin","motivation","n"],
  ["It does not matter how slowly you go as long as you do not stop.","Confucius","motivation","n"],
  ["The best time to plant a tree was 20 years ago; the second best is now.","Chinese Proverb","motivation","n"],
  ["You can't use up creativity. The more you use, the more you have.","Maya Angelou","motivation","n"],
  ["One small step for man, one giant leap for all of mankind.","Neil Armstrong","history","n","Armstrong landed on the moon on July 20, 1969."],
  ["Imagination is more important than knowledge, for knowledge is limited.","Albert Einstein","philosophy","n"],
  ["You've got to ask yourself one question: do I feel lucky? Well, do ya, punk?","Dirty Harry","movie","n","From the 1971 Clint Eastwood film."],
  ["You can't handle the truth! Son, we live in a world with walls.","A Few Good Men, paraphrase","movie","n"],
  ["Get busy living, or get busy dying. That is the only real choice.","The Shawshank Redemption","movie","n","Said by Andy Dufresne (Tim Robbins) in the 1994 film."],
  ["Why do we fall? So we can learn to pick ourselves back up.","Batman Begins","movie","n"],
  ["There is no greater agony than bearing an untold story inside you.","Maya Angelou","motivation","n","From I Know Why the Caged Bird Sings."],
  ["The only true wisdom is in knowing you know nothing at all.","Socrates","philosophy","n"],
  ["What we think, we become. Our thoughts shape our entire world.","Buddha","philosophy","n"],
  ["The lion does not turn around when a small dog barks at him.","African Proverb","tunisian","n"],
  ["He who does not travel does not fully know the value of other men.","Ibn Battuta","tunisian","n","Ibn Battuta traveled over 75,000 miles in the 14th century."],
  ["Knowledge without action is like a tree without fruit.","Arabic Proverb","tunisian","n"],
  ["One good thing about music is that when it hits you, you feel no pain.","Bob Marley","music","n"],
  ["Always forgive your enemies; nothing annoys them so much.","Oscar Wilde","humor","n"],
  ["I have not failed. I've just found 10,000 ways that won't work.","Thomas Edison","motivation","n"],
  ["Do not go where the path may lead; go instead where there is no path.","Ralph Waldo Emerson","motivation","n"],
  ["We are what we repeatedly do. Excellence is not an act, but a habit.","Aristotle","philosophy","n"],
  ["The secret of change is to focus your energy on building the new.","Socrates","motivation","n"],
  ["People will forget what you said, but never how you made them feel.","Maya Angelou","motivation","n"],
  ["A day without laughter is a day wasted. Make someone smile today.","Charlie Chaplin, adapted","humor","n"],
  ["Behind every great man there is a great woman rolling her eyes.","Jim Carrey","humor","n"],
  ["Stars cannot shine without darkness. Embrace your struggles.","Proverb","motivation","n"],
  ["To change the world, you must first change yourself from the inside out.","Mahatma Gandhi","motivation","n"],
  ["Music gives wings to the mind, flight to the imagination, and life to everything.","Plato","music","n"],
  ["In seeking wisdom you are wise; imagining you have attained it, you are a fool.","Rabbi Ben Azai","philosophy","n"],
  ["A journey of a thousand miles begins with a single step forward.","Lao Tzu","motivation","n"],
  ["Yesterday is history, tomorrow is a mystery, and today is a gift.","Alice Morse Earle, adapted","philosophy","n"],
  ["The privilege of a lifetime is being who you are and never apologizing for it.","Carl Jung","motivation","n"],
  ["Science without religion is lame, religion without science is blind.","Albert Einstein","philosophy","n"],
  ["Education is not the filling of a bucket, but the lighting of a fire.","William Butler Yeats","motivation","n"],
  ["If you want to know the measure of a man, watch how he treats others.","Anonymous","motivation","n"],

  // ── HARD ──────────────────────────────────────────────────────
  ["The greatest glory in living lies not in never falling, but in rising every time we fall.","Nelson Mandela","motivation","h","Mandela used this idea to inspire South Africa after apartheid."],
  ["It is not death that a man should fear, but he should fear never beginning to live.","Marcus Aurelius","philosophy","h","From Meditations, written in the 2nd century AD."],
  ["In the end, it's not the years in your life that count. It's the life in your years.","Abraham Lincoln","motivation","h"],
  ["Success is not final, failure is not fatal: it is the courage to continue that counts.","Winston Churchill","motivation","h"],
  ["The most difficult thing is to make decisions, and the rest is merely tenacity and hard work.","Amelia Earhart","motivation","h","Earhart was the first woman to fly solo across the Atlantic Ocean."],
  ["You have power over your mind, not outside events. Realize this and you will find true strength.","Marcus Aurelius","philosophy","h"],
  ["Darkness cannot drive out darkness; only light can do that. Hate cannot drive out hate; only love can.","Martin Luther King Jr.","history","h","From Strength to Love (1963)."],
  ["I am not afraid of storms, for I am learning how to sail my ship through the roughest of seas.","Louisa May Alcott","motivation","h","Alcott wrote this in Little Women (1868)."],
  ["First they ignore you, then they laugh at you, then they fight you, then you win.","Mahatma Gandhi","history","h"],
  ["Logic will get you from A to B. But imagination will take you everywhere in the universe.","Albert Einstein","philosophy","h"],
  ["The way to get started is to quit talking and begin doing. Action beats intention every time.","Walt Disney","motivation","h"],
  ["The two most important days in your life are the day you are born and the day you find out why.","Mark Twain","philosophy","h"],
  ["Innovation distinguishes between a leader and a follower. Dare to be different every single day.","Steve Jobs","motivation","h"],
  ["Live as if you were to die tomorrow. Learn as if you were to live forever, growing wiser with every breath.","Mahatma Gandhi","motivation","h"],
  ["There is only one way to avoid criticism: do nothing, say nothing, and be nothing at all.","Aristotle","humor","h"],
  ["The mind that opens to a new idea never returns to its original size. That is the power of learning.","Albert Einstein","philosophy","h"],
  ["Whoever is happy will make others happy too. That is the only true measure of real human kindness.","Anne Frank","philosophy","h","From Anne Frank's diary, written while hiding from the Nazis."],
  ["We must accept finite disappointment, but we must never lose infinite hope in the face of adversity.","Martin Luther King Jr.","motivation","h"],
  ["The only person you are destined to become is the person you decide to be each single day you live.","Ralph Waldo Emerson","motivation","h"],
  ["Nothing in life is to be feared, it is only to be understood. Now is the time to understand more.","Marie Curie","philosophy","h","Curie was the first person to win two Nobel Prizes."],
  ["Education is the most powerful weapon which you can use to change the world around you.","Nelson Mandela","history","h"],
  ["He who fights with monsters should look to it that he himself does not become a monster.","Friedrich Nietzsche","philosophy","h","From Beyond Good and Evil (1886)."],
  ["For it is in giving that we receive, and in losing ourselves that we find the greatest truth.","St. Francis of Assisi","philosophy","h"],
  ["Twenty years from now you will be more disappointed by the things you didn't do than by the ones you did.","Mark Twain","motivation","h"],
  ["The greatest revolution of our generation is discovering that human beings can alter their lives.","William James","motivation","h"],
  ["Try not to become a person of success, but rather try to become a person of value and true purpose.","Albert Einstein","motivation","h"],
  ["When you reach the end of your rope, tie a knot in it and hold on with all your might.","Franklin D. Roosevelt","motivation","h"],
  ["Do what you feel in your heart to be right, even if you will be criticized no matter what you do.","Eleanor Roosevelt","motivation","h"],
  ["A ship in the harbor is safe, but that is not what ships are for. Sail into the unknown.","William G.T. Shedd","motivation","h"],
  ["The purpose of life is not to be happy alone, but to be useful, honorable, and deeply compassionate.","Ralph Waldo Emerson","philosophy","h"],
  ["A leader is one who knows the way, goes the way, and shows the way to those who are willing to follow.","John C. Maxwell","motivation","h"],
  ["Not everything that is faced can be changed, but nothing can be changed until it is faced head-on.","James Baldwin","motivation","h"],
  ["The measure of intelligence is the ability to change when change is necessary and wisdom demands it.","Albert Einstein","philosophy","h"],
  ["The world is changed by your example, not by your opinion alone, for actions speak louder than words.","Paulo Coelho","motivation","h"],
  ["Know thyself, control thyself, give of thyself to the world, and the world shall reward you greatly.","Ancient Proverb","philosophy","h"],
  ["Blessed are those who dream, for they will eventually have to wake up and make those dreams real.","Anonymous","motivation","h"],
  ["We are all tattooed in our cradles with the beliefs of our tribe; the record seems superficial.","Oliver Wendell Holmes","philosophy","h"],
  ["Science and religion are not enemies; they are two sides of the same coin in our search for truth.","Anonymous","philosophy","h"],
  ["The secret of success is to know something nobody else knows, and to use it wisely and fearlessly.","Anonymous","motivation","h"],
  ["In seeking wisdom you are wise; imagining that you have attained it, thou art indeed a fool.","Rabbi Ben Azai","philosophy","h"],

  // ── EXPERT ────────────────────────────────────────────────────
  ["I've learned that people will forget what you said, people will forget what you did, but people will never forget how you made them feel.","Maya Angelou","motivation","x","Angelou is one of the most quoted women in the world."],
  ["I have a dream that my four little children will one day live in a nation where they will not be judged by the color of their skin but by their character.","Martin Luther King Jr.","history","x","Delivered at the March on Washington, DC, on August 28, 1963."],
  ["To be yourself in a world that is constantly trying to make you something else is the greatest accomplishment a human being can achieve in a lifetime.","Ralph Waldo Emerson","motivation","x"],
  ["We hold these truths to be self-evident, that all men are created equal, endowed by their Creator with certain unalienable Rights among these Life and Liberty.","Thomas Jefferson","history","x","From the United States Declaration of Independence, 1776."],
  ["The world is a book, and those who do not travel read only one page; those who travel read every chapter and write their own remarkable story.","St. Augustine, adapted","motivation","x"],
  ["Thousands of candles can be lighted from a single candle, and the life of the candle will not be shortened. Happiness never decreases by being shared.","Buddha","philosophy","x"],
  ["Our deepest fear is not that we are inadequate. Our deepest fear is that we are powerful beyond measure. It is our light, not our darkness, that most frightens us.","Marianne Williamson","motivation","x","From A Return to Love (1992)."],
  ["In the depth of winter, I finally learned that within me there lay an invincible summer. That discovery changed everything about how I faced the cold seasons of life.","Albert Camus","philosophy","x","Camus won the Nobel Prize in Literature in 1957."],
  ["Many of life's failures are people who did not realize how close they were to success when they gave up and walked away. Do not be one of them.","Thomas Edison","motivation","x"],
  ["Keep your face always toward the sunshine, and shadows will fall behind you. That is the motto of those who choose to live with joy and purpose.","Walt Whitman","motivation","x"],
  ["The key is not to prioritize what is on your schedule, but to schedule your priorities wisely, for time once lost can never be regained by anyone.","Stephen Covey","motivation","x","From The 7 Habits of Highly Effective People."],
  ["Not everything that can be counted counts, and not everything that counts can be counted. That is the paradox at the heart of all meaningful measurement.","William Bruce Cameron","philosophy","x"],
  ["I am not discouraged, because every wrong attempt discarded is another step forward toward the goal. Failure and success are two sides of the same coin.","Thomas Edison","motivation","x"],
  ["The mediocre teacher tells, the good teacher explains, the superior teacher demonstrates, and the great teacher inspires those around them every day.","William Arthur Ward","motivation","x"],
  ["If you hear a voice within you saying you cannot paint, then by all means paint and that voice will be silenced by the beauty of your own creation.","Vincent van Gogh","motivation","x"],
  ["The most wasted of all days is one without laughter, without learning, and without love. Fill each day with purpose, curiosity, and connections that matter.","Nicolas Chamfort, adapted","motivation","x"],
  ["All that is gold does not glitter, not all those who wander are lost; the old that is strong does not wither, deep roots are not reached by the frost.","J.R.R. Tolkien","music","x","From the poem All that is gold does not glitter in The Fellowship of the Ring."],
  ["You have brains in your head, you have feet in your shoes, you can steer yourself in any direction you choose. You are on your own and you know what you know.","Dr. Seuss","motivation","x","From Oh, the Places You'll Go! (1990)."],
  ["Yesterday is history, tomorrow is a mystery, but today is a gift; that is why they call it the present. Open it fully and live every moment with deep intention.","Anonymous","motivation","x"],
  ["The privilege of a lifetime is being who you are, standing fully in your truth, and never apologizing for the person that life and experience have shaped you to become.","Carl Jung, adapted","motivation","x"],
  ["Not the ones speaking the same language but the ones sharing the same feeling understand each other, and that understanding forms the truest bond of human friendship.","Rumi","philosophy","x","Rumi was a 13th-century Persian poet and Islamic scholar."],
  ["We do not inherit the earth from our ancestors; we borrow it from our children, and we owe them a world worth living in when they finally come of age and take our place.","Native American Proverb","tunisian","x"],
  ["In the garden of life, patience is the water that nourishes every seed; those who cannot wait will never taste the sweetest fruit that time and perseverance bring forth.","Arabic Proverb","tunisian","x"],
  ["The ink of the scholar is holier than the blood of the martyr, for knowledge is the light that guides humanity through every darkness it will ever encounter on its path.","Islamic Proverb","tunisian","x"],
  ["Whoever does not know the past has no present and no future; learn your history, honor your roots, and build upon the foundation of those who came before and paved your way.","Arabic adapted","tunisian","x"],
  ["The tongue has no bones, but it is strong enough to break a heart; use it wisely, for every word you speak leaves a permanent mark that cannot always be undone by apology.","Tunisian Proverb","tunisian","x"],
  ["Music, when soft voices die, vibrates in the memory; odours, when sweet violets sicken, live within the sense they quicken in our hearts and remain with us forever.","Percy Bysshe Shelley","music","x"],
  ["The reason we struggle with insecurity is because we compare our behind-the-scenes with everyone else's highlight reel, and inevitably find ourselves painfully wanting.","Steven Furtick","motivation","x"],
  ["Your time is limited, so don't waste it living someone else's life. Don't be trapped by dogma, which is living with the results of other people's thinking and choices.","Steve Jobs","motivation","x","From Jobs' 2005 Stanford commencement address."],
  ["Believe you can and you're halfway there; the remaining half is nothing but relentless action, unwavering persistence, and the courage to never stop trying no matter what.","Theodore Roosevelt","motivation","x"],
];

// ── RNG helper (seeded) ──────────────────────────────────────────
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── State ────────────────────────────────────────────────────────
let gameMode = 'hub';          // 'hub' | 'solo' | 'daily' | 'pvp'
let currentTokens = null;      // [{k:'l'|'s'|'p', n?:num, c?:char}]
let currentCipher = null;      // {ltn:{A:7,...}, ntl:{7:'A',...}}
let playerMap = new Map();     // cipherNum → letter (player's correct assignments)
let pendingMap = new Map();    // cipherNum → letter (solo tentative, before confirm)
let preRevealedNums = new Set();
let uniqueNums = [];
let selectedNum = null;
let letterCells = [];          // ordered array of .cg-cell elements
let numToCells = new Map();    // cipherNum → [cell elements]
let currentQuote = null;       // [text, author, cat, diff, fact?]
let currentDiff = 'n';
let currentCat = 'all';

// Timer
let timerStart = 0;
let timerElapsed = 0;
let timerInterval = null;
let timerStarted = false;
let timerPaused = false;

// Solo counters
let mistakesCount = 0;
let hintsUsed = 0;
let hintsLeft = 3;

// Auto-save
let autoSaveInterval = null;

// PvP
let ws = null;
let myId = null;
let leaderId = null;
const players = new Map();
let pvpDiff = 'n';
let pvpCat = 'all';
let pvpGameActive = false;
let pvpMistakes = 0;
let pvpHintUsed = false;
let pvpOppName = '';
let pvpTotalUnique = 0;

// ── Utility ──────────────────────────────────────────────────────
function showScreen(id) {
  for (const el of [screenHub, screenConfig, screenPvPLobby, screenPuzzle])
    el.style.display = 'none';
  if (id === 'hub') screenHub.style.display = '';
  else if (id === 'config') screenConfig.style.display = '';
  else if (id === 'pvp-lobby') screenPvPLobby.style.display = '';
  else if (id === 'puzzle') screenPuzzle.style.display = '';
}

function wsSend(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function showStatus(txt) {
  statusEl.textContent = txt;
  statusEl.style.display = '';
  setTimeout(() => { statusEl.style.display = 'none'; }, 4000);
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Stats helpers ────────────────────────────────────────────────
function loadStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; } catch { return {}; }
}
function saveStats(stats) {
  localStorage.setItem(STATS_KEY, JSON.stringify(stats));
}
function recordCompletion(diff, elapsed, mistakes, hints) {
  const stats = loadStats();
  if (!stats[diff]) stats[diff] = { completed:0, bestTime:null, totalTime:0, totalMistakes:0, totalHints:0 };
  const d = stats[diff];
  d.completed++;
  d.totalTime += elapsed;
  d.totalMistakes += mistakes;
  d.totalHints += hints;
  if (d.bestTime === null || elapsed < d.bestTime) d.bestTime = elapsed;
  saveStats(stats);
}

// ── Daily challenge ──────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function dailySeed(date) {
  let h = 5381;
  for (let i = 0; i < date.length; i++) h = ((h << 5) + h) + date.charCodeAt(i);
  return (h >>> 0);
}
function getDailyData() {
  try { return JSON.parse(localStorage.getItem(DAILY_KEY)) || {}; } catch { return {}; }
}
function saveDailyData(data) { localStorage.setItem(DAILY_KEY, JSON.stringify(data)); }

function getDailyStreak() {
  const data = getDailyData();
  return data.streak || 0;
}

function isDailyDone() {
  const data = getDailyData();
  return data.lastCompleted === todayStr() || data.lastAttempted === todayStr();
}

function initDailyCard() {
  const streak = getDailyStreak();
  dailyStreak.textContent = `🔥 Streak: ${streak}`;
  const done = isDailyDone();
  if (done) {
    dailyStatus.textContent = 'Already completed today!';
    btnDailyChallenge.textContent = '✓ Done';
    btnDailyChallenge.disabled = true;
    dailyCard.classList.add('completed');
  } else {
    dailyStatus.textContent = "Today's puzzle is waiting!";
    btnDailyChallenge.textContent = 'Play Today';
    btnDailyChallenge.disabled = false;
    dailyCard.classList.remove('completed');
  }
}

function startDailyChallenge() {
  if (isDailyDone()) return;
  const date = todayStr();
  const seed = dailySeed(date);
  const rng = mulberry32(seed);
  const diffs = ['n','h','e','x'];
  const dayIdx = Math.floor((Date.now() - new Date(date.slice(0,4)+'-01-01').getTime()) / 86400000) % 4;
  const diff = diffs[dayIdx];
  const pool = CG_QUOTES.filter(q => q[3] === diff);
  const quote = pool[Math.floor(rng() * pool.length)];

  const data = getDailyData();
  data.lastAttempted = date;
  saveDailyData(data);

  gameMode = 'daily';
  currentDiff = diff;
  currentCat = 'all';
  startSoloPuzzle(quote, diff, /*seed=*/seed + 1);
}

// ── Quote picking ────────────────────────────────────────────────
function pickQuote(diff, cat) {
  const stats = loadStats();
  const seenKey = `seen_${diff}_${cat}`;
  let seen;
  try { seen = new Set(JSON.parse(localStorage.getItem(seenKey) || '[]')); } catch { seen = new Set(); }

  const pool = CG_QUOTES.filter((q,i) => q[3] === diff && (cat === 'all' || q[2] === cat));
  if (pool.length === 0) {
    // fallback: all categories
    const fallback = CG_QUOTES.filter(q => q[3] === diff);
    return fallback[Math.floor(Math.random() * fallback.length)];
  }
  let unused = pool.filter(q => {
    const idx = CG_QUOTES.indexOf(q);
    return !seen.has(idx);
  });
  if (unused.length === 0) {
    // reset seen for this pool
    seen = new Set();
    unused = pool;
  }
  const chosen = unused[Math.floor(Math.random() * unused.length)];
  const idx = CG_QUOTES.indexOf(chosen);
  seen.add(idx);
  localStorage.setItem(seenKey, JSON.stringify([...seen]));
  return chosen;
}

// ── Cipher generation ────────────────────────────────────────────
function generateCipher(seed) {
  const rng = mulberry32(seed);
  const nums = Array.from({length: 26}, (_, i) => i + 1);
  for (let i = 25; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  const ltn = {}, ntl = {};
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(65 + i);
    ltn[l] = nums[i];
    ntl[nums[i]] = l;
  }
  return {ltn, ntl};
}

function encryptQuote(text, ltn) {
  return text.toUpperCase().split('').map(ch => {
    if (/[A-Z]/.test(ch)) return {k:'l', n:ltn[ch]};
    if (ch === ' ') return {k:'s'};
    return {k:'p', c:ch};
  });
}

function getPreRevealed(tokens, ntl, diff) {
  const count = DIFF_REVEAL[diff] || 0;
  const uNums = [...new Set(tokens.filter(t=>t.k==='l').map(t=>t.n))];
  // Shuffle
  for (let i = uNums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [uNums[i], uNums[j]] = [uNums[j], uNums[i]];
  }
  return uNums.slice(0, count).map(n => ({n, l:ntl[n]}));
}

// ── Start solo puzzle ────────────────────────────────────────────
function startSoloPuzzle(quote, diff, seed) {
  currentQuote = quote;
  currentDiff = diff;

  const cipherSeed = seed || (Math.random() * 0xFFFFFFFF >>> 0);
  currentCipher = generateCipher(cipherSeed);
  currentTokens = encryptQuote(quote[0], currentCipher.ltn);
  uniqueNums = [...new Set(currentTokens.filter(t=>t.k==='l').map(t=>t.n))];
  preRevealedNums = new Set();

  const preRev = getPreRevealed(currentTokens, currentCipher.ntl, diff);
  playerMap = new Map();
  pendingMap = new Map();
  for (const {n, l} of preRev) {
    playerMap.set(n, l);
    preRevealedNums.add(n);
  }

  hintsLeft = DIFF_HINTS[diff];
  hintsUsed = 0;
  mistakesCount = 0;
  timerElapsed = 0;
  timerStarted = false;
  timerPaused = false;

  phCategory.textContent = `${CAT_ICONS[quote[2]] || ''} ${quote[2]}`;
  phDifficulty.textContent = DIFF_NAMES[diff];
  hintCountEl.textContent = hintsLeft;
  hintCountBtnEl.textContent = hintsLeft;
  mistakeCountEl.textContent = 0;
  timerDisplay.textContent = '0:00';
  authorHintBar.textContent = `— ${quote[1]}`;
  opponentPanel.style.display = 'none';

  sidebarTitleEl.textContent = 'Stats';
  playerCountEl.textContent = '';
  playerListEl.innerHTML = '';
  updateSoloStatsSidebar();

  buildPuzzleGrid();
  buildLetterTray();
  updateLetterTray();

  // Check pre-revealed cells
  for (const n of preRevealedNums) {
    setCellsForNum(n, currentCipher.ntl[n], 'pre-revealed');
  }

  showScreen('puzzle');
  btnPause.style.display = '';
  hintStatWrap.style.display = '';
  hiddenInput.focus();

  // Auto-save
  clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(autoSave, 10000);
  autoSave();
}

// ── Load/save progress ───────────────────────────────────────────
function autoSave() {
  if (gameMode !== 'solo' && gameMode !== 'daily') return;
  const save = {
    quote: currentQuote,
    diff: currentDiff,
    mode: gameMode,
    cipher: currentCipher,
    tokens: currentTokens,
    playerMap: [...playerMap.entries()],
    preRevealedNums: [...preRevealedNums],
    uniqueNums,
    elapsed: timerElapsed + (timerStarted && !timerPaused ? Math.floor((Date.now() - timerStart) / 1000) : 0),
    mistakes: mistakesCount,
    hints: hintsUsed,
    hintsLeft,
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(save));
}

function hasSavedGame() {
  return !!localStorage.getItem(SAVE_KEY);
}

function loadSavedGame() {
  const save = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
  if (!save || !save.quote || !save.cipher) return false;
  currentQuote = save.quote;
  currentDiff = save.diff;
  gameMode = save.mode || 'solo';
  currentCipher = save.cipher;
  currentTokens = save.tokens;
  uniqueNums = save.uniqueNums;
  preRevealedNums = new Set(save.preRevealedNums || []);
  playerMap = new Map(save.playerMap || []);
  pendingMap = new Map();
  hintsLeft = save.hintsLeft ?? DIFF_HINTS[currentDiff];
  hintsUsed = save.hints || 0;
  mistakesCount = save.mistakes || 0;
  timerElapsed = save.elapsed || 0;
  timerStarted = false;
  timerPaused = false;

  phCategory.textContent = `${CAT_ICONS[currentQuote[2]] || ''} ${currentQuote[2]}`;
  phDifficulty.textContent = DIFF_NAMES[currentDiff];
  hintCountEl.textContent = hintsLeft;
  hintCountBtnEl.textContent = hintsLeft;
  mistakeCountEl.textContent = mistakesCount;
  timerDisplay.textContent = fmtTime(timerElapsed);
  authorHintBar.textContent = `— ${currentQuote[1]}`;
  opponentPanel.style.display = 'none';

  sidebarTitleEl.textContent = 'Stats';
  playerCountEl.textContent = '';
  playerListEl.innerHTML = '';

  buildPuzzleGrid();
  buildLetterTray();

  // Restore state
  for (const [num, letter] of playerMap) {
    const style = preRevealedNums.has(num) ? 'pre-revealed' : 'solved';
    setCellsForNum(num, letter, style);
  }
  updateLetterTray();
  updateSoloStatsSidebar();

  showScreen('puzzle');
  btnPause.style.display = '';
  hintStatWrap.style.display = '';
  hiddenInput.focus();

  clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(autoSave, 10000);
  return true;
}

// ── Grid builder ─────────────────────────────────────────────────
function buildPuzzleGrid() {
  puzzleGrid.innerHTML = '';
  letterCells = [];
  numToCells = new Map();
  selectedNum = null;

  let wordDiv = null;

  currentTokens.forEach((token, idx) => {
    if (token.k === 's') {
      wordDiv = null;
      const sp = document.createElement('div');
      sp.className = 'cg-space';
      puzzleGrid.appendChild(sp);
    } else if (token.k === 'p') {
      const el = document.createElement('div');
      el.className = 'cg-punct';
      el.textContent = token.c;
      if (wordDiv) wordDiv.appendChild(el);
      else puzzleGrid.appendChild(el);
    } else {
      // Letter cell
      if (!wordDiv) {
        wordDiv = document.createElement('div');
        wordDiv.className = 'cg-word';
        puzzleGrid.appendChild(wordDiv);
      }
      const cell = document.createElement('div');
      cell.className = 'cg-cell';
      cell.dataset.num = token.n;
      cell.dataset.idx = idx;
      cell.tabIndex = 0;

      const letterSpan = document.createElement('span');
      letterSpan.className = 'cell-letter';

      const numSpan = document.createElement('span');
      numSpan.className = 'cell-num';
      numSpan.textContent = token.n;

      cell.appendChild(letterSpan);
      cell.appendChild(numSpan);

      cell.addEventListener('click', () => selectNum(token.n, cell));
      cell.addEventListener('touchstart', e => { e.preventDefault(); selectNum(token.n, cell); }, {passive:false});

      letterCells.push(cell);
      wordDiv.appendChild(cell);

      if (!numToCells.has(token.n)) numToCells.set(token.n, []);
      numToCells.get(token.n).push(cell);
    }
  });
}

// ── Cell selection ───────────────────────────────────────────────
function selectNum(num, cellEl) {
  // Deselect previous
  if (selectedNum !== null) {
    const prev = numToCells.get(selectedNum) || [];
    prev.forEach(c => {
      c.classList.remove('selected');
      // restore proper state
      const letter = playerMap.get(selectedNum);
      if (letter) {
        c.classList.add(preRevealedNums.has(selectedNum) ? 'pre-revealed' : 'solved');
      }
    });
  }

  selectedNum = num;

  // Highlight all cells with this num
  const cells = numToCells.get(num) || [];
  cells.forEach(c => {
    c.classList.remove('solved','pre-revealed','conflict');
    c.classList.add('selected');
  });

  updateLetterTrayHighlight();
  hiddenInput.focus();
}

function deselectAll() {
  if (selectedNum !== null) {
    const cells = numToCells.get(selectedNum) || [];
    cells.forEach(c => {
      c.classList.remove('selected');
      const letter = playerMap.get(selectedNum);
      if (letter) {
        c.classList.add(preRevealedNums.has(selectedNum) ? 'pre-revealed' : 'solved');
      }
    });
  }
  selectedNum = null;
  updateLetterTrayHighlight();
}

// ── Cell fill ────────────────────────────────────────────────────
function setCellsForNum(num, letter, style) {
  const cells = numToCells.get(num) || [];
  cells.forEach((c, i) => {
    c.querySelector('.cell-letter').textContent = letter || '';
    c.className = 'cg-cell ' + (style || '');
    if (num === selectedNum) c.classList.add('selected');
  });
}

function cascadeFillNum(num, letter, style, onDone) {
  const cells = numToCells.get(num) || [];
  if (!cells.length) { if (onDone) onDone(); return; }
  cells.forEach((c, i) => {
    setTimeout(() => {
      c.querySelector('.cell-letter').textContent = letter;
      c.className = 'cg-cell cascade-fill ' + (style || 'solved');
      if (num === selectedNum) c.classList.add('selected');
      setTimeout(() => {
        c.classList.remove('cascade-fill');
        if (num === selectedNum) c.classList.add('selected');
      }, 400);
      if (i === cells.length - 1 && onDone) setTimeout(onDone, 400);
    }, i * 35);
  });
  checkWordComplete(num);
}

function flashCellsForNum(num, cls) {
  const cells = numToCells.get(num) || [];
  cells.forEach(c => {
    c.classList.add(cls);
    setTimeout(() => c.classList.remove(cls), 600);
  });
}

function checkWordComplete(triggerNum) {
  // Find words containing cells of this num
  puzzleGrid.querySelectorAll('.cg-word').forEach(word => {
    const cells = word.querySelectorAll('.cg-cell');
    const allSolved = [...cells].every(c => {
      const n = Number(c.dataset.num);
      return playerMap.has(n);
    });
    if (allSolved) {
      cells.forEach(c => {
        c.classList.add('word-complete');
        setTimeout(() => c.classList.remove('word-complete'), 600);
      });
    }
  });
}

// ── Keyboard input ───────────────────────────────────────────────
hiddenInput.addEventListener('keydown', e => {
  if (gameMode === 'pvp' && !pvpGameActive) return;
  if (gameMode === 'solo' || gameMode === 'daily') {
    if (timerPaused) return;
    if (!timerStarted && selectedNum !== null && /^[a-zA-Z]$/.test(e.key)) {
      startTimer();
    }
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    jumpToNextUnsolved();
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    navigateCells(1);
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    navigateCells(-1);
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (selectedNum !== null) clearNum(selectedNum);
    return;
  }
  if (e.key === 'Escape') {
    deselectAll();
    return;
  }
  if (/^[a-zA-Z]$/.test(e.key)) {
    e.preventDefault();
    if (selectedNum === null) return;
    const letter = e.key.toUpperCase();
    if (gameMode === 'pvp') {
      placePvPLetter(selectedNum, letter);
    } else {
      placeSoloLetter(selectedNum, letter);
    }
  }
});

// Keep focus on hidden input
hiddenInput.addEventListener('blur', () => {
  setTimeout(() => { if (document.activeElement !== hiddenInput) hiddenInput.focus(); }, 0);
});

function navigateCells(dir) {
  if (selectedNum === null) {
    if (letterCells.length) selectNum(Number(letterCells[0].dataset.num), letterCells[0]);
    return;
  }
  // Find first cell of selected num
  const firstIdx = letterCells.findIndex(c => Number(c.dataset.num) === selectedNum);
  if (firstIdx === -1) return;
  let next = firstIdx + dir;
  while (next >= 0 && next < letterCells.length) {
    const nextNum = Number(letterCells[next].dataset.num);
    if (nextNum !== selectedNum) {
      selectNum(nextNum, letterCells[next]);
      return;
    }
    next += dir;
  }
}

function jumpToNextUnsolved() {
  const unsolved = uniqueNums.filter(n => !playerMap.has(n));
  if (!unsolved.length) return;
  const idx = selectedNum !== null ? unsolved.indexOf(selectedNum) : -1;
  const nextNum = unsolved[(idx + 1) % unsolved.length];
  const cell = numToCells.get(nextNum)?.[0];
  if (cell) selectNum(nextNum, cell);
}

// ── Solo letter placement ────────────────────────────────────────
function placeSoloLetter(num, letter) {
  if (preRevealedNums.has(num)) return; // can't overwrite pre-revealed

  // Check conflict: is letter already used for another num?
  let conflictNum = null;
  for (const [n, l] of playerMap) {
    if (l === letter && n !== num) { conflictNum = n; break; }
  }
  for (const [n, l] of pendingMap) {
    if (l === letter && n !== num) { conflictNum = n; break; }
  }

  if (conflictNum !== null) {
    flashCellsForNum(num, 'conflict');
    flashCellsForNum(conflictNum, 'conflict');
    showStatus(`⚠️ Letter ${letter} is already used for number ${conflictNum}`);
    mistakesCount++;
    mistakeCountEl.textContent = mistakesCount;
    updateSoloStatsSidebar();
    return;
  }

  // Place letter
  pendingMap.set(num, letter);
  // In solo, validate against cipher
  const correct = currentCipher.ntl[num] === letter;
  if (correct) {
    playerMap.set(num, letter);
    pendingMap.delete(num);
    cascadeFillNum(num, letter, 'solved', () => {
      updateLetterTray();
      updateSoloStatsSidebar();
      checkSoloWin();
    });
  } else {
    mistakesCount++;
    mistakeCountEl.textContent = mistakesCount;
    pendingMap.delete(num);
    // Flash red then clear so player knows immediately
    flashCellsForNum(num, 'pvp-wrong');
    showStatus(`✗ ${letter} is wrong here — ${mistakesCount} mistake${mistakesCount !== 1 ? 's' : ''}`);
    updateLetterTray();
    updateSoloStatsSidebar();
  }

  // Move to next unsolved after placing
  if (correct) {
    setTimeout(() => jumpToNextUnsolved(), 100);
  }
}

function clearNum(num) {
  if (preRevealedNums.has(num)) return;
  playerMap.delete(num);
  pendingMap.delete(num);
  const cells = numToCells.get(num) || [];
  cells.forEach(c => {
    c.querySelector('.cell-letter').textContent = '';
    c.className = 'cg-cell' + (num === selectedNum ? ' selected' : '');
  });
  updateLetterTray();
  updateSoloStatsSidebar();
  autoSave();
}

function checkSoloWin() {
  // Win when all unique nums are in playerMap with correct letters
  const allSolved = uniqueNums.every(n => playerMap.has(n));
  if (!allSolved) return;

  // Double-check correctness
  const allCorrect = uniqueNums.every(n => currentCipher.ntl[n] === playerMap.get(n));
  if (!allCorrect) return;

  // Also check pending - no wrong pending
  for (const [n, l] of pendingMap) {
    if (currentCipher.ntl[n] !== l) return; // still wrong ones pending
  }

  stopTimer();
  clearInterval(autoSaveInterval);
  localStorage.removeItem(SAVE_KEY);

  const totalElapsed = timerElapsed;
  const score = calcScore(currentDiff, totalElapsed, mistakesCount, hintsUsed);

  recordCompletion(currentDiff, totalElapsed, mistakesCount, hintsUsed);

  if (gameMode === 'daily') {
    const data = getDailyData();
    const today = todayStr();
    const prevCompleted = data.lastCompleted;
    data.lastCompleted = today;
    // Streak logic
    if (prevCompleted) {
      const prev = new Date(prevCompleted);
      const now = new Date(today);
      const diff = (now - prev) / 86400000;
      data.streak = diff <= 1 ? (data.streak || 0) + 1 : 1;
    } else {
      data.streak = 1;
    }
    saveDailyData(data);
    initDailyCard();
  }

  // Submit score
  const gameKey = `cryptogram_${currentDiff === 'e' ? 'easy' : currentDiff === 'n' ? 'normal' : currentDiff === 'h' ? 'hard' : 'expert'}`;
  reportScore(gameKey, score);

  showSoloResult(score, totalElapsed);
}

function calcScore(diff, elapsed, mistakes, hints) {
  const mult = DIFF_MULT[diff] || 1;
  const base = 5000 - elapsed * 3;
  const par = DIFF_PAR[diff] || 300;
  const speedBonus = elapsed < par / 2 ? 500 : 0;
  return Math.max(100, Math.floor(base * mult - 150 * mistakes - 400 * hints + speedBonus));
}

// ── Timer ────────────────────────────────────────────────────────
function startTimer() {
  if (timerStarted) return;
  timerStarted = true;
  timerStart = Date.now() - timerElapsed * 1000;
  timerInterval = setInterval(() => {
    if (timerPaused) return;
    timerElapsed = Math.floor((Date.now() - timerStart) / 1000);
    timerDisplay.textContent = fmtTime(timerElapsed);
  }, 500);
}

function pauseTimer() {
  timerPaused = true;
  timerElapsed = Math.floor((Date.now() - timerStart) / 1000);
}

function resumeTimer() {
  timerPaused = false;
  timerStart = Date.now() - timerElapsed * 1000;
}

function stopTimer() {
  clearInterval(timerInterval);
  timerElapsed = Math.floor((Date.now() - timerStart) / 1000);
}

// Pause on tab visibility change
document.addEventListener('visibilitychange', () => {
  if ((gameMode === 'solo' || gameMode === 'daily') && timerStarted && !timerPaused) {
    if (document.hidden) pauseTimer();
    else resumeTimer();
  }
});

// ── Hint system (solo) ───────────────────────────────────────────
function useHint(type) {
  if (hintsLeft <= 0) { showStatus('No hints left!'); return; }
  if (gameMode === 'pvp') {
    usePvPHint();
    return;
  }

  if (!timerStarted) startTimer();
  hintsLeft--;
  hintsUsed++;
  hintCountEl.textContent = hintsLeft;
  hintCountBtnEl.textContent = hintsLeft;

  // Default: reveal a random unsolved num
  const unsolved = uniqueNums.filter(n => !playerMap.has(n));
  if (!unsolved.length) { hintsLeft++; hintsUsed--; hintCountEl.textContent = hintsLeft; hintCountBtnEl.textContent = hintsLeft; return; }

  // For freq hint: pick most-common unsolved num
  let targetNum;
  if (type === 'freq') {
    // Pick the unsolved num that appears most often
    let maxCount = 0;
    for (const n of unsolved) {
      const cnt = (numToCells.get(n) || []).length;
      if (cnt > maxCount) { maxCount = cnt; targetNum = n; }
    }
  } else {
    targetNum = unsolved[Math.floor(Math.random() * unsolved.length)];
  }

  const letter = currentCipher.ntl[targetNum];
  playerMap.set(targetNum, letter);
  pendingMap.delete(targetNum);
  preRevealedNums.add(targetNum); // treat as revealed
  cascadeFillNum(targetNum, letter, 'pre-revealed hint-reveal', () => {
    updateLetterTray();
    updateSoloStatsSidebar();
    checkSoloWin();
  });
  flashCellsForNum(targetNum, 'hint-reveal');
  showStatus(`💡 Hint: Number ${targetNum} = ${letter}`);
  autoSave();
}

// ── Letter tray ──────────────────────────────────────────────────
const QWERTY = [['Q','W','E','R','T','Y','U','I','O','P'],['A','S','D','F','G','H','J','K','L'],['Z','X','C','V','B','N','M']];

function buildLetterTray() {
  letterTrayEl.innerHTML = '';
  QWERTY.forEach(row => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'tray-row';
    row.forEach(letter => {
      const key = document.createElement('div');
      key.className = 'tray-key';
      key.dataset.letter = letter;
      key.innerHTML = `<span class="tk-letter">${letter}</span><span class="tk-num"></span>`;
      key.addEventListener('click', () => {
        if (selectedNum === null) return;
        if (gameMode === 'pvp') placePvPLetter(selectedNum, letter);
        else placeSoloLetter(selectedNum, letter);
      });
      rowDiv.appendChild(key);
    });
    letterTrayEl.appendChild(rowDiv);
  });
}

function updateLetterTray() {
  // Build reverse map: letter → cipher num
  const letterToNum = new Map();
  for (const [n, l] of playerMap) letterToNum.set(l, n);
  for (const [n, l] of pendingMap) if (!letterToNum.has(l)) letterToNum.set(l, n);

  letterTrayEl.querySelectorAll('.tray-key').forEach(key => {
    const letter = key.dataset.letter;
    const numEl = key.querySelector('.tk-num');
    const assignedNum = letterToNum.get(letter);
    if (assignedNum !== undefined) {
      key.classList.add('used');
      numEl.textContent = assignedNum;
    } else {
      key.classList.remove('used');
      numEl.textContent = '';
    }
    key.classList.remove('active-select');
  });
}

function updateLetterTrayHighlight() {
  // Highlight the key that's assigned to selected num
  letterTrayEl.querySelectorAll('.tray-key').forEach(key => key.classList.remove('active-select'));
  if (selectedNum === null) return;
  const letter = playerMap.get(selectedNum) || pendingMap.get(selectedNum);
  if (letter) {
    const key = letterTrayEl.querySelector(`[data-letter="${letter}"]`);
    if (key) key.classList.add('active-select');
  }
}

function updateSoloStatsSidebar() {
  const solved = playerMap.size;
  const total = uniqueNums.length;
  const pct = total ? Math.round(solved / total * 100) : 0;
  const sidebarEl = $('soloStatsSidebar');
  sidebarEl.innerHTML = `
    <div class="ss-row"><span>Progress</span><span class="ss-val">${solved}/${total} (${pct}%)</span></div>
    <div class="ss-row"><span>Mistakes</span><span class="ss-val">${mistakesCount}</span></div>
    <div class="ss-row"><span>Hints used</span><span class="ss-val">${hintsUsed}</span></div>
    <div class="ss-row"><span>Hints left</span><span class="ss-val">${hintsLeft}</span></div>
  `;
}

// ── Frequency panel ──────────────────────────────────────────────
function buildFreqPanel() {
  freqBarsEl.innerHTML = '';
  const freq = new Map();
  currentTokens.forEach(t => {
    if (t.k === 'l') freq.set(t.n, (freq.get(t.n) || 0) + 1);
  });
  const sorted = [...freq.entries()].sort((a,b) => b[1]-a[1]);
  const maxCount = sorted[0]?.[1] || 1;
  sorted.forEach(([n, cnt]) => {
    const pct = Math.round(cnt / maxCount * 100);
    const letter = playerMap.get(n) || '?';
    const row = document.createElement('div');
    row.className = 'freq-row';
    row.innerHTML = `
      <span class="freq-label">${n}</span>
      <div class="freq-bar-bg"><div class="freq-bar-fill" style="width:${pct}%"></div></div>
      <span class="freq-count">${cnt}</span>
      <span style="font-size:.65rem;color:var(--accent-g);width:14px">${letter !== '?' ? letter : ''}</span>
    `;
    row.addEventListener('click', () => {
      const cell = numToCells.get(n)?.[0];
      if (cell) selectNum(n, cell);
    });
    freqBarsEl.appendChild(row);
  });
}

// ── Solo result screen ───────────────────────────────────────────
function showSoloResult(score, elapsed) {
  gameMode = 'ended';

  resultBanner.className = 'result-banner solo-win';
  resultBanner.textContent = '🎉 SOLVED!';
  resultQuoteReveal.textContent = `"${currentQuote[0]}"`;
  resultMeta.textContent = `— ${currentQuote[1]}`;

  const funFact = currentQuote[4] || '';
  resultFunfact.textContent = funFact;
  resultFunfact.style.display = funFact ? '' : 'none';

  resultStatsGrid.innerHTML = `
    <div class="rs-stat"><div class="rs-val">${fmtTime(elapsed)}</div><div class="rs-label">Time</div></div>
    <div class="rs-stat"><div class="rs-val">${score.toLocaleString()}</div><div class="rs-label">Score</div></div>
    <div class="rs-stat"><div class="rs-val">${mistakesCount}</div><div class="rs-label">Mistakes</div></div>
    <div class="rs-stat"><div class="rs-val">${hintsUsed}</div><div class="rs-label">Hints</div></div>
    <div class="rs-stat"><div class="rs-val">${DIFF_NAMES[currentDiff]}</div><div class="rs-label">Difficulty</div></div>
    <div class="rs-stat"><div class="rs-val">${CAT_ICONS[currentQuote[2]] || '🌟'}</div><div class="rs-label">${currentQuote[2]}</div></div>
  `;

  const shareText = `🔐 Cryptogram — ${gameMode === 'daily' ? 'Daily Challenge' : DIFF_NAMES[currentDiff]}\n⏱ ${fmtTime(elapsed)} | 💯 ${score.toLocaleString()} pts | ❌ ${mistakesCount} mistakes\n"${currentQuote[0].slice(0,40)}..."`;
  resultShareRow.style.display = '';
  btnShareResult.onclick = () => {
    navigator.clipboard.writeText(shareText).then(() => showStatus('📋 Copied!')).catch(() => {});
  };

  resultActionsRow.innerHTML = '';
  const btnNew = document.createElement('button');
  btnNew.className = 'btn btn-primary';
  btnNew.textContent = 'New Puzzle';
  btnNew.onclick = () => {
    resultOverlay.style.display = 'none';
    showScreen('config');
  };
  const btnHub = document.createElement('button');
  btnHub.className = 'btn btn-back btn-sm';
  btnHub.textContent = 'Hub';
  btnHub.onclick = () => { resultOverlay.style.display = 'none'; goToHub(); };
  resultActionsRow.appendChild(btnNew);
  resultActionsRow.appendChild(btnHub);

  resultOverlay.style.display = 'flex';

  // Confetti
  launchConfetti();
}

// ── Confetti ─────────────────────────────────────────────────────
function launchConfetti() {
  const canvas = document.createElement('canvas');
  canvas.id = 'confettiCanvas';
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:150;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = Array.from({length:100}, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height - canvas.height,
    vx: (Math.random() - .5) * 3,
    vy: Math.random() * 4 + 2,
    color: ['#7c3aed','#06b6d4','#f59e0b','#34d399','#a78bfa'][Math.floor(Math.random()*5)],
    size: Math.random() * 8 + 4,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - .5) * .2,
  }));

  let frame = 0;
  const animate = () => {
    if (frame++ > 180) { canvas.remove(); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.angle += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size/2);
      ctx.restore();
    });
    requestAnimationFrame(animate);
  };
  animate();
}

// ── PvP WebSocket ────────────────────────────────────────────────
function connectPvP() {
  roomBadgeEl.textContent = `Room ${roomId}`;
  sidebarTitleEl.textContent = 'Players';

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const pw = sessionStorage.getItem('arena-room-password') || undefined;
    sessionStorage.removeItem('arena-room-password');
    wsSend({type:'join-room', roomId, name:myName, password:pw, token:sessionStorage.getItem('arena-token')||''});
  };
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    showStatus('Disconnected. Returning to lobby…');
    setTimeout(() => { location.href = '/'; }, 3000);
  };
}

function renderPlayerList() {
  playerListEl.innerHTML = '';
  playerCountEl.textContent = players.size;
  for (const [pid, p] of players) {
    const el = document.createElement('div');
    el.className = 'player-item' + (pid === myId ? ' is-me' : '');
    el.textContent = p.name + (pid === leaderId ? ' 👑' : '') + (pid === myId ? ' (you)' : '');
    playerListEl.appendChild(el);
  }
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'room-joined':
      myId = msg.myId;
      leaderId = msg.leaderId;
      players.set(myId, {name: myName});
      for (const p of msg.players) players.set(p.id, {name:p.name});
      renderPlayerList();
      showScreen('pvp-lobby');

      // Show/hide host config
      if (leaderId === myId) {
        pvpConfig.style.display = '';
        btnStartPvP.style.display = '';
        pvpLobbyStatus.textContent = 'You are the host. Configure and start!';
      } else {
        pvpConfig.style.display = 'none';
        btnStartPvP.style.display = 'none';
        pvpLobbyStatus.textContent = 'Waiting for host to start the game…';
      }
      break;

    case 'player-joined':
      players.set(msg.id, {name:msg.name});
      leaderId = msg.leaderId;
      renderPlayerList();
      pvpLobbyStatus.textContent = `${escHtml(msg.name)} joined! ${players.size}/2 players.`;
      if (leaderId === myId) {
        pvpConfig.style.display = '';
        btnStartPvP.style.display = players.size >= 2 ? '' : 'none';
      }
      break;

    case 'player-left':
      players.delete(msg.id);
      leaderId = msg.leaderId;
      renderPlayerList();
      if (pvpGameActive) {
        pvpGameActive = false;
        showStatus('Opponent disconnected. You win by default!');
        // Show result
        showPvPResult(true, 'Opponent left', timerElapsed, pvpMistakes, 0, 0, 0);
      }
      break;

    case 'cg-lobby-config':
      pvpDiff = msg.difficulty || 'n';
      pvpCat = msg.category || 'all';
      // Update guest UI
      if (leaderId !== myId) {
        pvpLobbyStatus.textContent = `Host chose: ${DIFF_NAMES[pvpDiff]} — ${pvpCat}`;
      }
      break;

    case 'cg-game-start':
      startPvPGame(msg);
      break;

    case 'cg-placement-result':
      handlePvPPlacementResult(msg);
      break;

    case 'cg-first-solve':
      if (msg.winnerId === myId) {
        flashCellsForNum(msg.cipherNum, 'first-solve-flash');
      }
      break;

    case 'cg-progress':
      updateOpponentProgress(msg);
      break;

    case 'cg-hint-reveal':
      applyPvPHintReveal(msg.cipherNum, msg.letter);
      break;

    case 'cg-hint-used':
      // Opponent used hint
      oppHintFlag.style.display = '';
      break;

    case 'cg-game-over':
      handlePvPGameOver(msg);
      break;

    case 'cg-opponent-left':
      pvpGameActive = false;
      showStatus(`${escHtml(msg.winnerName)} wins — opponent disconnected.`);
      showPvPResult(msg.winnerId === myId, '', timerElapsed, pvpMistakes, 0, 0, 0);
      break;

    case 'cg-rematch-requested':
      // Show rematch button to this player
      const rematchBtn = resultActionsRow.querySelector('.rematch-btn');
      if (rematchBtn) rematchBtn.textContent = 'Accept Rematch!';
      break;

    case 'cg-rematch-start':
      resultOverlay.style.display = 'none';
      pvpGameActive = false;
      players.forEach(p => p.gameState = null);
      showScreen('pvp-lobby');
      pvpLobbyStatus.textContent = 'Rematch starting…';
      break;

    case 'error':
      alert(msg.msg);
      location.href = '/';
      break;
  }
}

// ── PvP game start ───────────────────────────────────────────────
function startPvPGame(msg) {
  gameMode = 'pvp';
  pvpGameActive = true;
  pvpMistakes = 0;
  pvpHintUsed = false;
  currentTokens = msg.tokens;
  currentDiff = msg.difficulty;
  pvpTotalUnique = msg.totalUnique;
  uniqueNums = [...new Set(currentTokens.filter(t=>t.k==='l').map(t=>t.n))];
  preRevealedNums = new Set();
  playerMap = new Map();
  pendingMap = new Map();

  // Apply pre-revealed
  for (const {n, l} of (msg.preRevealed || [])) {
    playerMap.set(n, l);
    preRevealedNums.add(n);
  }

  // Find opponent
  for (const [pid, p] of players) {
    if (pid !== myId) {
      pvpOppName = p.name;
      break;
    }
  }

  oppName.textContent = pvpOppName;
  oppAvatar.textContent = pvpOppName[0]?.toUpperCase() || '?';
  oppSub.textContent = 'Solving…';
  oppBarFill.style.width = '0%';
  oppBarLabel.textContent = `0 / ${pvpTotalUnique} letters cracked`;
  oppHintFlag.style.display = 'none';

  phCategory.textContent = `${CAT_ICONS[msg.category] || '🌟'} ${msg.category || ''}`;
  phDifficulty.textContent = DIFF_NAMES[currentDiff];
  hintCountEl.textContent = 1;
  hintCountBtnEl.textContent = 1;
  hintsLeft = 1;
  mistakeCountEl.textContent = 0;
  authorHintBar.textContent = `— ${msg.authorHint || ''}`;
  opponentPanel.style.display = '';

  // Build mini grid for opponent tracking
  buildOppMiniGrid();

  buildPuzzleGrid();
  buildLetterTray();

  // Apply pre-revealed
  for (const n of preRevealedNums) {
    setCellsForNum(n, playerMap.get(n), 'pre-revealed');
  }

  updateLetterTray();

  // Start timer
  timerElapsed = 0;
  timerStarted = false;
  timerStart = Date.now();
  timerInterval = setInterval(() => {
    timerElapsed = Math.floor((Date.now() - timerStart) / 1000);
    timerDisplay.textContent = fmtTime(timerElapsed);
  }, 500);

  showScreen('puzzle');
  btnPause.style.display = 'none'; // no pause in PvP
  hintStatWrap.style.display = '';
  hiddenInput.focus();
}

function buildOppMiniGrid() {
  oppMiniGrid.innerHTML = '';
  // One block per token, spaces shown smaller
  currentTokens.forEach(t => {
    const cell = document.createElement('div');
    if (t.k === 's') {
      cell.className = 'opp-mini-cell space';
    } else if (t.k === 'l') {
      cell.className = 'opp-mini-cell';
      cell.dataset.num = t.n;
    } else {
      cell.className = 'opp-mini-cell space';
    }
    oppMiniGrid.appendChild(cell);
  });
}

function updateOppMiniGrid(solvedNums) {
  const solvedSet = new Set(solvedNums);
  oppMiniGrid.querySelectorAll('.opp-mini-cell[data-num]').forEach(cell => {
    const n = Number(cell.dataset.num);
    cell.classList.toggle('filled', solvedSet.has(n));
  });
}

// ── PvP letter placement ─────────────────────────────────────────
function placePvPLetter(num, letter) {
  if (preRevealedNums.has(num)) return;
  if (!timerStarted) {
    timerStarted = true;
    timerStart = Date.now();
  }
  wsSend({type:'cg-letter', cipherNum: num, letter});
  // Show tentative (grey) while awaiting server response
  const cells = numToCells.get(num) || [];
  cells.forEach(c => { c.querySelector('.cell-letter').textContent = letter; });
}

function handlePvPPlacementResult(msg) {
  const {cipherNum, correct, mistakesCount: mc} = msg;
  pvpMistakes = mc;
  mistakeCountEl.textContent = mc;

  if (correct) {
    playerMap.set(cipherNum, ''); // mark as solved (we don't know the letter from server in new flow)
    // Actually server sends back that it's correct - we need the letter
    // We'll trust the tentative display (the cell already shows the letter)
    const cells = numToCells.get(cipherNum) || [];
    const shownLetter = cells[0]?.querySelector('.cell-letter')?.textContent || '';
    playerMap.set(cipherNum, shownLetter);
    cascadeFillNum(cipherNum, shownLetter, 'solved', () => {
      updateLetterTray();
    });
  } else {
    // Wrong - flash red, clear
    const cells = numToCells.get(cipherNum) || [];
    cells.forEach(c => {
      c.classList.add('pvp-wrong');
      setTimeout(() => {
        c.classList.remove('pvp-wrong');
        c.querySelector('.cell-letter').textContent = '';
        // Restore proper state
        const letter = playerMap.get(cipherNum);
        if (letter) {
          c.querySelector('.cell-letter').textContent = letter;
          c.classList.add('solved');
        }
      }, 400);
    });
  }
}

function updateOpponentProgress(msg) {
  const {percent, solved, total, solvedNums, hintUsed} = msg;
  oppBarFill.style.width = `${percent}%`;
  oppBarLabel.textContent = `${solved} / ${total} letters cracked`;
  oppSub.textContent = `${percent}% solved`;

  if (hintUsed) oppHintFlag.style.display = '';

  // Urgency when opponent is within 10%
  const myPct = Math.round(playerMap.size / uniqueNums.length * 100);
  if (percent >= 90 && percent > myPct) {
    urgencyEdge.style.display = '';
    oppBarFill.classList.add('urgent');
  } else {
    urgencyEdge.style.display = 'none';
    oppBarFill.classList.remove('urgent');
  }

  if (solvedNums) updateOppMiniGrid(solvedNums);
}

// ── PvP hint ─────────────────────────────────────────────────────
function usePvPHint() {
  if (pvpHintUsed) { showStatus('Already used your hint!'); return; }
  pvpHintUsed = true;
  hintsLeft = 0;
  hintCountEl.textContent = 0;
  hintCountBtnEl.textContent = 0;
  wsSend({type:'cg-hint'});
}

function applyPvPHintReveal(cipherNum, letter) {
  playerMap.set(cipherNum, letter);
  preRevealedNums.add(cipherNum);
  cascadeFillNum(cipherNum, letter, 'pre-revealed hint-reveal', () => {
    updateLetterTray();
  });
  showStatus(`💡 Hint: Number ${cipherNum} = ${letter} (+30s time penalty)`);
}

// ── PvP game over ────────────────────────────────────────────────
function handlePvPGameOver(msg) {
  pvpGameActive = false;
  clearInterval(timerInterval);
  urgencyEdge.style.display = 'none';

  const won = msg.winnerId === myId;
  showPvPResult(won, msg.winnerName, msg.winnerTime, msg.winnerMistakes, msg.loserMistakes, msg.loserPercent, msg.fullText, msg.author, msg.funFact);

  if (won) {
    reportScore('cryptogram', 1);
    launchConfetti();
  }
}

function showPvPResult(won, winnerName, winnerTime, winnerMistakes, loserMistakes, loserPercent, fullText, author, funFact) {
  resultBanner.className = won ? 'result-banner win' : 'result-banner lose';
  resultBanner.textContent = won ? '🏆 YOU WIN!' : '😤 So close…';

  if (fullText) {
    resultQuoteReveal.textContent = `"${fullText}"`;
    resultMeta.textContent = `— ${author || ''}`;
  } else {
    resultQuoteReveal.textContent = '';
    resultMeta.textContent = '';
  }

  resultFunfact.textContent = funFact || '';
  resultFunfact.style.display = funFact ? '' : 'none';

  if (won) {
    resultStatsGrid.innerHTML = `
      <div class="rs-stat"><div class="rs-val">${fmtTime(winnerTime)}</div><div class="rs-label">Your Time</div></div>
      <div class="rs-stat"><div class="rs-val">${winnerMistakes}</div><div class="rs-label">Your Mistakes</div></div>
      <div class="rs-stat"><div class="rs-val">${loserMistakes}</div><div class="rs-label">Opp Mistakes</div></div>
    `;
  } else {
    resultStatsGrid.innerHTML = `
      <div class="rs-stat"><div class="rs-val">${fmtTime(winnerTime || 0)}</div><div class="rs-label">Winner's Time</div></div>
      <div class="rs-stat"><div class="rs-val">${loserPercent || 0}%</div><div class="rs-label">Your Progress</div></div>
      <div class="rs-stat"><div class="rs-val">${winnerMistakes}</div><div class="rs-label">Winner Mistakes</div></div>
    `;
  }

  resultShareRow.style.display = 'none';

  resultActionsRow.innerHTML = '';
  const btnRematch = document.createElement('button');
  btnRematch.className = 'btn btn-primary rematch-btn';
  btnRematch.textContent = '🔄 Rematch';
  btnRematch.onclick = () => { wsSend({type:'cg-rematch-request'}); btnRematch.textContent = 'Waiting…'; btnRematch.disabled = true; };

  const btnHubBtn = document.createElement('button');
  btnHubBtn.className = 'btn btn-back btn-sm';
  btnHubBtn.textContent = 'Lobby';
  btnHubBtn.onclick = () => { location.href = '/'; };

  resultActionsRow.appendChild(btnRematch);
  resultActionsRow.appendChild(btnHubBtn);
  resultOverlay.style.display = 'flex';
}

// ── Leaderboard ──────────────────────────────────────────────────
async function loadLeaderboard(gameKey) {
  lbContent.innerHTML = '<div class="lb-loading">Loading…</div>';
  try {
    const r = await fetch(`/api/leaderboard?game=${encodeURIComponent(gameKey)}`);
    const entries = await r.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      lbContent.innerHTML = '<div class="lb-loading">No scores yet.</div>';
      return;
    }
    const myUid = sessionStorage.getItem('arena-uid');
    lbContent.innerHTML = '';
    entries.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'lb-row' + (e.uid === myUid ? ' my-rank' : '');
      const rankClass = i === 0 ? ' gold' : '';
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : e.rank;
      row.innerHTML = `<span class="lb-rank${rankClass}">${medal}</span><span class="lb-name">${escHtml(e.displayName)}</span><span class="lb-score">${e.score?.toLocaleString()}</span>`;
      lbContent.appendChild(row);
    });
  } catch {
    lbContent.innerHTML = '<div class="lb-loading">Failed to load.</div>';
  }
}

function showLeaderboard() {
  lbOverlay.style.display = 'flex';
  const activeTab = lbTabs.querySelector('.lb-cg-tab.active');
  loadLeaderboard(activeTab?.dataset.game || 'cryptogram_normal');
}

// ── Stats overlay ────────────────────────────────────────────────
function showStats() {
  const stats = loadStats();
  const daily = getDailyData();
  statsContent.innerHTML = '';

  const diffs = ['e','n','h','x'];
  const diffMap = {e:'Easy',n:'Normal',h:'Hard',x:'Expert'};
  diffs.forEach(d => {
    const s = stats[d];
    if (!s || !s.completed) return;
    const section = document.createElement('div');
    section.innerHTML = `<div class="stat-section">${diffMap[d]}</div>`;
    const rows = [
      ['Completed', s.completed],
      ['Best Time', fmtTime(s.bestTime || 0)],
      ['Avg Time', fmtTime(Math.round((s.totalTime||0) / s.completed))],
      ['Total Mistakes', s.totalMistakes || 0],
      ['Total Hints', s.totalHints || 0],
    ];
    rows.forEach(([label, val]) => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = `<span>${label}</span><span class="stat-row-val">${val}</span>`;
      section.appendChild(row);
    });
    statsContent.appendChild(section);
  });

  const streakRow = document.createElement('div');
  streakRow.innerHTML = `<div class="stat-section">Daily Challenge</div><div class="stat-row"><span>Streak</span><span class="stat-row-val">🔥 ${daily.streak||0}</span></div>`;
  statsContent.appendChild(streakRow);

  if (!statsContent.children.length) {
    statsContent.innerHTML = '<div class="lb-loading">No stats yet. Play some puzzles!</div>';
  }

  statsOverlay.style.display = 'flex';
}

// ── Hub navigation ───────────────────────────────────────────────
function goToHub() {
  clearInterval(autoSaveInterval);
  clearInterval(timerInterval);
  gameMode = 'hub';
  showScreen('hub');
  initDailyCard();
}

// ── Button wiring ────────────────────────────────────────────────
btnBack.addEventListener('click', () => { location.href = '/'; });
btnToggleSidebar.addEventListener('click', () => sidebar.classList.toggle('open'));

btnRules.addEventListener('click', () => { rulesOverlay.style.display = 'flex'; });
btnCloseRules.addEventListener('click', () => { rulesOverlay.style.display = 'none'; });

btnSoloMode.addEventListener('click', () => {
  gameMode = 'solo';
  // Check for saved game
  if (hasSavedGame()) {
    if (confirm('Resume your saved game?')) {
      loadSavedGame();
      return;
    } else {
      localStorage.removeItem(SAVE_KEY);
    }
  }
  showScreen('config');
});

btnPvPMode.addEventListener('click', () => {
  // Redirect to lobby to create PvP room
  location.href = '/';
});

btnDailyChallenge.addEventListener('click', () => {
  if (!isDailyDone()) startDailyChallenge();
});

btnHubStats.addEventListener('click', showStats);
btnHubLeaderboard.addEventListener('click', showLeaderboard);

btnBackFromConfig.addEventListener('click', () => showScreen('hub'));

// Difficulty pills
diffPills.addEventListener('click', e => {
  const btn = e.target.closest('[data-diff]');
  if (!btn) return;
  diffPills.querySelectorAll('.diff-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});
catPills.addEventListener('click', e => {
  const btn = e.target.closest('[data-cat]');
  if (!btn) return;
  catPills.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});

btnStartSolo.addEventListener('click', () => {
  const diff = diffPills.querySelector('.diff-pill.active')?.dataset.diff || 'n';
  const cat = catPills.querySelector('.cat-pill.active')?.dataset.cat || 'all';
  currentDiff = diff;
  currentCat = cat;
  gameMode = 'solo';
  const quote = pickQuote(diff, cat);
  startSoloPuzzle(quote, diff);
});

// PvP lobby
pvpDiffPills.addEventListener('click', e => {
  const btn = e.target.closest('[data-diff]');
  if (!btn || leaderId !== myId) return;
  pvpDiffPills.querySelectorAll('.diff-pill').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  pvpDiff = btn.dataset.diff;
  wsSend({type:'cg-config', difficulty: pvpDiff, category: pvpCategory.value});
});
pvpCategory.addEventListener('change', () => {
  if (leaderId !== myId) return;
  pvpCat = pvpCategory.value;
  wsSend({type:'cg-config', difficulty: pvpDiff, category: pvpCat});
});
btnStartPvP.addEventListener('click', () => {
  if (leaderId !== myId) return;
  const diff = pvpDiffPills.querySelector('.diff-pill.active')?.dataset.diff || 'n';
  const cat = pvpCategory.value || 'all';
  wsSend({type:'cg-start', difficulty:diff, category:cat});
});

// Puzzle controls
btnHint.addEventListener('click', () => {
  if (gameMode === 'pvp') usePvPHint();
  else useHint('random');
});

btnFreq.addEventListener('click', () => {
  if (freqPanel.style.display === 'none') {
    buildFreqPanel();
    freqPanel.style.display = '';
  } else {
    freqPanel.style.display = 'none';
  }
});
btnCloseFreq.addEventListener('click', () => { freqPanel.style.display = 'none'; });

btnPause.addEventListener('click', () => {
  if (gameMode !== 'solo' && gameMode !== 'daily') return;
  pauseTimer();
  autoSave();
  pauseOverlay.style.display = 'flex';
  hiddenInput.blur();
});
btnResume.addEventListener('click', () => {
  pauseOverlay.style.display = 'none';
  resumeTimer();
  hiddenInput.focus();
});
btnQuitToHub.addEventListener('click', () => {
  pauseOverlay.style.display = 'none';
  stopTimer();
  autoSave();
  goToHub();
});

// Stats/LB overlays
btnCloseStats.addEventListener('click', () => { statsOverlay.style.display = 'none'; });
btnCloseLb.addEventListener('click', () => { lbOverlay.style.display = 'none'; });
lbTabs.addEventListener('click', e => {
  const tab = e.target.closest('.lb-cg-tab');
  if (!tab) return;
  lbTabs.querySelectorAll('.lb-cg-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  loadLeaderboard(tab.dataset.game);
});

// Click outside overlays to close
[statsOverlay, lbOverlay, rulesOverlay].forEach(ov => {
  ov.addEventListener('click', e => { if (e.target === ov) ov.style.display = 'none'; });
});

// ── Init ─────────────────────────────────────────────────────────
if (isPvP) {
  gameMode = 'pvp';
  connectPvP();
} else {
  gameMode = 'hub';
  showScreen('hub');
  initDailyCard();

  // Show solo stats in sidebar
  $('soloStatsSidebar').innerHTML = '';
  $('playerCount').textContent = '';
  $('playerList').innerHTML = '';
}

})();
