const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const filter = require('leo-profanity');
const axios = require('axios');
const OpenAI = require('openai');

// Load environment variables
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: [
            "http://localhost:3000",
            "http://localhost:5000",
            "https://nord-chat.netlify.app", // Old Netlify URL
            "https://micahswebsite.xyz", // Your custom domain
            "http://micahswebsite.xyz"   // HTTP version (just in case)
        ],
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 5000;

// Weather API Configuration
const WEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || 'b8a4f2e3c1d7b9f8a6e5d4c3b2a1f9e8'; // Demo key - replace with real key

// ChatGPT API Configuration
let chatGPTApiKey = null;
let chatGPTEnabledBy = null; // Track who enabled ChatGPT
let openaiClient = null;
let chatGPTConversation = []; // Store conversation history
let selectedGPTModel = 'gpt-4o-mini'; // Default model

// Helper function to get local timestamp
function getLocalTimestamp() {
    // Explicitly set to Central Time (CT) - covers both CST and CDT automatically
    return new Date().toLocaleString('en-US', { 
        timeZone: 'America/Chicago', // Central Time Zone
        hour12: true,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// Store messages and online users
const messages = [];
const maxMessages = 20;
const onlineUsers = {};

// Store active trivia sessions
const activeTrivia = new Map(); // questionId -> { question, answer, askedBy, answeredBy: Set() }

// Store blocked IPs per user
const userBlockedIPs = new Map(); // socketId -> Set of blocked IP addresses

// Serve static files from frontend directory
app.use(express.static(path.join(__dirname, '../frontend')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/room1', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/room1.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle user joining
    socket.on('join', (data) => {
        let { username } = data;
        const userIP = socket.handshake.address;
        
        // Clean username on server side as backup
        username = username.replace(/[^a-zA-Z0-9_]/g, '');
        
        if (username.length === 0) {
            socket.emit('error', { message: 'Invalid username. Please use only letters, numbers, and underscores.' });
            return;
        }
        
        console.log(`User ${username} joined from IP: ${userIP}`);
        
        onlineUsers[username] = socket.id;
        
        // Broadcast user joined
        io.emit('user joined', username);
        
        // Broadcast updated online users list
        io.emit('online users update', { onlineUsers: Object.keys(onlineUsers) });
        
        // Send last 20 messages to new user (filtered by their blocked IPs)
        const filteredMessages = messages.filter(msg => 
            !userBlockedIPs.get(socket.id)?.has(msg.ip)
        );
        socket.emit('load messages', filteredMessages);
    });    // Handle new messages
    socket.on('message', async (msg) => {
        const timestamp = getLocalTimestamp();
        const userIP = socket.handshake.address;
        
        // Check for DM pattern: @username message
        const dmMatch = msg.text.match(/^@(\w+)\s+(.+)$/);
        if (dmMatch) {
            const targetUsername = dmMatch[1];
            const dmMessage = dmMatch[2];
            
            // Find the target user's socket ID
            const targetSocketId = onlineUsers[targetUsername];
            
            if (targetSocketId) {
                // Check if the target user has blocked the sender
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                const targetBlockedIPs = userBlockedIPs.get(targetSocketId);
                
                if (targetBlockedIPs && targetBlockedIPs.has(userIP)) {
                    // Target user has blocked the sender
                    const blockedMessage = {
                        username: "System",
                        text: `❌ Your DM to "${targetUsername}" was not delivered. You may be blocked by this user.`,
                        timestamp: timestamp
                    };
                    socket.emit('message', blockedMessage);
                    return;
                }
                
                // NO CONTENT MODERATION FOR DMs - Send directly without filtering
                const dmToTarget = {
                    username: `📩 DM from ${msg.username}`,
                    text: `**Private Message:** ${dmMessage}`,
                    timestamp: timestamp,
                    isDM: true,
                    fromUser: msg.username,
                    toUser: targetUsername,
                    ip: userIP // Include IP for potential blocking
                };
                
                // Send confirmation to sender
                const dmConfirmation = {
                    username: `📤 DM sent to ${targetUsername}`,
                    text: `**Your message:** ${dmMessage}`,
                    timestamp: timestamp,
                    isDM: true,
                    fromUser: msg.username,
                    toUser: targetUsername
                };
                
                // Send to both users only
                io.to(targetSocketId).emit('message', dmToTarget);
                socket.emit('message', dmConfirmation);
                
                console.log(`DM from ${msg.username} to ${targetUsername}: ${dmMessage} (NO MODERATION)`);
                return; // Don't process as regular message
            } else {
                // User not found or offline
                const errorMessage = {
                    username: "System",
                    text: `❌ User "${targetUsername}" not found or offline. DM not sent.`,
                    timestamp: timestamp
                };
                socket.emit('message', errorMessage);
                return;
            }
        }
        
        // Check for trivia answers first (before profanity filter)
        const userAnswer = msg.text.trim().toLowerCase();
        let triviaAnswered = false;
        
        for (const [questionId, session] of activeTrivia.entries()) {
            // Check if this user already answered this question
            if (session.answeredBy.has(socket.id)) {
                continue;
            }
            
            // Check if answer matches (allow partial matches and common variations)
            const correctAnswer = session.answer.toLowerCase();
            if (userAnswer === correctAnswer || 
                correctAnswer.includes(userAnswer) && userAnswer.length > 2 ||
                userAnswer.includes(correctAnswer)) {
                
                // Correct answer!
                session.answeredBy.add(socket.id);
                triviaAnswered = true;
                
                const successMessage = {
                    username: "🧠 Trivia Bot",
                    text: `🎉 **CORRECT!** ${msg.username} got it right!\n\n❓ ${session.question}\n✅ **Answer:** ${session.answer}\n\n🏆 Well done! Use /trivia for another question.`,
                    timestamp: timestamp
                };
                
                messages.push(successMessage);
                if (messages.length > maxMessages) {
                    messages.shift();
                }
                
                activeTrivia.delete(questionId);
                io.emit('message', successMessage);
                console.log(`${msg.username} answered trivia correctly: ${session.answer}`);
                return; // Don't process as regular message
            } else if (userAnswer.length > 2) { // Only count substantial answers as wrong
                // Wrong answer, but let them try again
                session.answeredBy.add(socket.id);
                
                const wrongMessage = {
                    username: "🧠 Trivia Bot", 
                    text: `❌ Not quite, ${msg.username}! Keep guessing...`,
                    timestamp: timestamp
                };
                
                messages.push(wrongMessage);
                if (messages.length > maxMessages) {
                    messages.shift();
                }
                
                io.emit('message', wrongMessage);
                triviaAnswered = true;
                return; // Don't process as regular message
            }
        }
        
        // If it was a trivia attempt, don't continue with normal message processing
        if (triviaAnswered) {
            return;
        }
        
        // AI Moderation vs Regular Profanity Filter
        if (chatGPTApiKey && openaiClient) {
            // Use AI moderation when ChatGPT is available
            try {
                const moderationResult = await openaiClient.chat.completions.create({
                    model: selectedGPTModel,
                    messages: [
                        {
                            role: "system",
                            content: "You are a chat moderator. Analyze the following message and determine if it contains inappropriate content (profanity, hate speech, harassment, spam, or other harmful content). Respond with only 'SAFE' if the message is appropriate, or 'INAPPROPRIATE: [brief reason]' if it should be blocked. Be reasonable - don't block normal conversation, jokes, or mild language."
                        },
                        {
                            role: "user",
                            content: `Message from user "${msg.username}": "${msg.text}"`
                        }
                    ],
                    max_tokens: 50,
                    temperature: 0.1
                });
                
                const moderationResponse = moderationResult.choices[0].message.content.trim();
                
                if (moderationResponse.startsWith('INAPPROPRIATE')) {
                    // AI detected inappropriate content
                    const reason = moderationResponse.split(':')[1]?.trim() || 'inappropriate content';
                    
                    const aiModerationMessage = {
                        username: "🤖 AI Moderator",
                        text: `⚠️ **Message Blocked**\n\n${msg.username}'s message was blocked for: ${reason}\n\n🔍 *AI moderation is active*`,
                        timestamp: timestamp
                    };
                    
                    messages.push(aiModerationMessage);
                    if (messages.length > maxMessages) {
                        messages.shift();
                    }
                    
                    console.log(`AI moderation blocked message from ${msg.username}: ${reason}`);
                    io.emit('message', aiModerationMessage);
                    return; // Don't process the original message
                }
                
                // If AI says it's safe, continue processing the message
                console.log(`AI moderation approved message from ${msg.username}`);
                
            } catch (error) {
                console.error('AI moderation error:', error.message);
                // Fall back to regular profanity filter if AI moderation fails
                if (filter.check(msg.text)) {
                    const profanityMessage = {
                        username: "System",
                        text: `${msg.username} tried to send a swear word! (AI moderation unavailable, using backup filter)`,
                        timestamp: timestamp
                    };
                    
                    messages.push(profanityMessage);
                    if (messages.length > maxMessages) {
                        messages.shift();
                    }
                    
                    console.log(`Backup profanity filter blocked message from ${msg.username}: ${msg.text}`);
                    io.emit('message', profanityMessage);
                    return;
                }
            }
        } else {
            // Use regular profanity filter when ChatGPT is not available
            if (filter.check(msg.text)) {
                const profanityMessage = {
                    username: "System",
                    text: `${msg.username} tried to send a swear word!`,
                    timestamp: timestamp
                };
                
                messages.push(profanityMessage);
                if (messages.length > maxMessages) {
                    messages.shift();
                }
                
                console.log(`Profanity blocked from ${msg.username}: ${msg.text}`);
                io.emit('message', profanityMessage);
                return; // Don't process the original message
            }
        }
        
        const messageWithTimestamp = {
            ...msg,
            timestamp: timestamp,
            ip: userIP
        };
        
        // Store message (keep only last 20)
        messages.push(messageWithTimestamp);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`Message from ${msg.username}: ${msg.text}`);
        
        // Broadcast message to all users (filtered per user's blocked IPs)
        for (const [socketId, socket] of io.sockets.sockets) {
            if (!userBlockedIPs.get(socketId)?.has(userIP)) {
                socket.emit('message', messageWithTimestamp);
            }
        }
    });// Handle 8-ball command
    socket.on('8ball', (data) => {
        const { question } = data;
        const timestamp = getLocalTimestamp();
        
        // Magic 8-Ball responses
        const responses = [
            "It is certain.",
            "It is decidedly so.",
            "Without a doubt.",
            "Yes definitely.",
            "You may rely on it.",
            "As I see it, yes.",
            "Most likely.",
            "Outlook good.",
            "Yes.",
            "Signs point to yes.",
            "Reply hazy, try again.",
            "Ask again later.",
            "Better not tell you now.",
            "Cannot predict now.",
            "Concentrate and ask again.",
            "Don't count on it.",
            "My reply is no.",
            "My sources say no.",  
            "Outlook not so good.",
            "Very doubtful."
        ];
        
        // Get random response
        const randomResponse = responses[Math.floor(Math.random() * responses.length)];
        
        // Create 8-Ball message
        const eightBallMessage = {
            username: "🎱 8-Ball",
            text: `🔮 "${question}"\n\n${randomResponse}`,
            timestamp: timestamp
        };
        
        // Store message (keep only last 20)
        messages.push(eightBallMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`8-Ball responded to: ${question}`);
        
        // Broadcast 8-Ball response to all users
        io.emit('message', eightBallMessage);
    });

    // Handle joke command
    socket.on('joke', () => {
        const timestamp = getLocalTimestamp();
        
        // Massive list of jokes
        const jokes = [
            "Why don't scientists trust atoms? Because they make up everything!",
            "I told my wife she was drawing her eyebrows too high. She looked surprised.",
            "Why did the scarecrow win an award? He was outstanding in his field!",
            "I haven't slept for ten days, because that would be too long.",
            "Want to hear a joke about construction? I'm still working on it.",
            "Why don't skeletons fight each other? They don't have the guts.",
            "I used to hate facial hair, but then it grew on me.",
            "What do you call a fake noodle? An impasta!",
            "How do you organize a space party? You planet!",
            "Why did the math book look so sad? Because it had too many problems!",
            "What's the best thing about Switzerland? I don't know, but the flag is a big plus.",
            "I invented a new word: Plagiarism!",
            "Why did the coffee file a police report? It got mugged!",
            "What do you call a bear with no teeth? A gummy bear!",
            "Why don't eggs tell jokes? They'd crack each other up!",
            "What do you call a dinosaur that crashes his car? Tyrannosaurus Wrecks!",
            "I'm reading a book about anti-gravity. It's impossible to put down!",
            "Why did the bicycle fall over? Because it was two tired!",
            "What do you call a sleeping bull? A bulldozer!",
            "Why don't programmers like nature? It has too many bugs.",
            "How does a penguin build its house? Igloos it together!",
            "What did one wall say to the other wall? I'll meet you at the corner!",
            "Why did the banana go to the doctor? It wasn't peeling well!",
            "What's orange and sounds like a parrot? A carrot!",
            "Why did the cookie go to the doctor? Because it felt crumbly!",
            "What do you call a cow with no legs? Ground beef!",
            "Why don't scientists trust stairs? Because they're always up to something!",
            "What do you call a fish wearing a crown? A king fish!",
            "Why did the tomato turn red? Because it saw the salad dressing!",
            "What do you get when you cross a snowman with a vampire? Frostbite!",
            "Why did the computer go to the doctor? Because it had a virus!",
            "What do you call a belt made of watches? A waist of time!",
            "Why don't oysters share? Because they're shellfish!",
            "What do you call a dog magician? A labracadabrador!",
            "Why did the golfer bring two pairs of pants? In case he got a hole in one!",
            "What do you call a group of disorganized cats? A cat-astrophe!",
            "Why don't elephants use computers? They're afraid of the mouse!",
            "What do you call a pig that does karate? A pork chop!",
            "Why did the teacher wear sunglasses? Because her students were so bright!",
            "What do you call a lazy kangaroo? A pouch potato!",
            "Why don't melons get married? Because they cantaloupe!",
            "What do you call a deer with no eyes? No idea!",
            "Why did the smartphone go to therapy? It had too many hang-ups!",
            "What do you call a factory that makes good products? A satisfactory!",
            "Why don't ghosts like rain? It dampens their spirits!",
            "What do you call a dinosaur with extensive vocabulary? A thesaurus!",
            "Why did the picture go to jail? Because it was framed!",
            "What do you call a cat that likes to bowl? An alley cat!",
            "Why don't mountains ever get cold? They wear snow caps!",
            "What do you call a shoe made of a banana? A slipper!",
            "Why did the robot go on a diet? He had a byte problem!",
            "What do you call a cow in an earthquake? A milkshake!",
            "Why don't books ever get cold? They have book jackets!",
            "What do you call a hippo at the North Pole? Lost!",
            "Why did the invisible man turn down the job offer? He couldn't see himself doing it!",
            "What do you call a pile of cats? A meowtain!",
            "Why don't calendars ever get lonely? They have dates!",
            "What do you call a duck that gets all A's? A wise quacker!",
            "Why did the stadium get hot after the game? All the fans left!",
            "What do you call a fish with two knees? A two-knee fish!",
            "Why don't clocks ever go hungry? They go back four seconds!",
            "What do you call a sleeping dinosaur? A dino-snore!",
            "Why did the teddy bear refuse dessert? She was stuffed!",
            "What do you call a unicorn with no horn? A horse!",
            "Why don't vampires go to barbecues? They don't like steak!",
            "What do you call a rabbit that's good at martial arts? A kung-fu bunny!",
            "Why did the cookie cry? Because its mother was a wafer so long!",
            "What do you call a snake that works for the government? A civil serpent!",
            "Why don't pizza slices ever get lonely? They come in groups of eight!",
            "What do you call a dinosaur that loves to sleep? A dino-snore!",
            "Why did the chicken cross the playground? To get to the other slide!",
            "What do you call a bear in the rain? A drizzly bear!",
            "Why don't robots ever panic? They have nerves of steel!",
            "What do you call a fish that needs help with vocals? Auto-tuna!",
            "Why did the lamp go to school? To get brighter!",
            "What do you call a dog that can do magic? A labracadabrador!",
            "Why don't mummies take vacations? They're afraid they'll relax and unwind!",
            "What do you call a fish wearing a bowtie? Sofishticated!",
            "Why did the broom get promoted? It was outstanding in its field!",
            "What do you call a dinosaur that crashes his car? Tyrannosaurus Wrecks!",
            "Why don't eggs ever win at poker? They always fold!",
            "What do you call a cow that plays the guitar? A moo-sician!",
            "Why did the grape stop in the middle of the road? Because it ran out of juice!",
            "What do you call a fake stone? A shamrock!",
            "Why don't fish pay taxes? Because they live below the sea level!",
            "What do you call a bee that can't make up its mind? A maybe!",
            "Why did the computer keep freezing? It left its Windows open!",
            "What do you call a pig that knows karate? A pork chop!",
            "Why don't books ever get tired? They have plenty of shelf life!",
            "What do you call a cow with a twitch? Beef jerky!",
            "Why did the pencil go to therapy? It had a point to make!",
            "What do you call a fish that wears a crown? Your Royal High-ness!",
            "Why don't clouds ever get speeding tickets? They're always floating!",
            "What do you call a dinosaur with a great vocabulary? A thesaurus!",
            "Why did the cookie go to the gym? To get ripped!",
            "What do you call a cat that gets what it wants? Purr-suasive!",
            "Why don't trees ever get stressed? They know how to branch out!",
            "What do you call a duck that gets all A's? A wise quacker!",
            "Why did the music teacher go to jail? For fingering A minor!",
            "What do you call a fish with a Ph.D? A brain sturgeon!",
            "Why don't shoes ever get lonely? They come in pairs!",
            "What do you call a cow that won't give milk? A milk dud!",
            "Why did the smartphone break up with the charger? It felt drained!",
            "What do you call a sleeping bull? A bulldozer!",
            "Why don't ghosts make good comedians? Their jokes are too dead-pan!"
        ];
        
        // Get random joke
        const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
        
        // Create joke message
        const jokeMessage = {
            username: "😂 Joke Bot",
            text: `🎭 ${randomJoke}`,
            timestamp: timestamp
        };
        
        // Store message (keep only last 20)
        messages.push(jokeMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log('Joke command used');
        
        // Broadcast joke to all users
        io.emit('message', jokeMessage);
    });

    // Handle flip command
    socket.on('flip', () => {
        const timestamp = getLocalTimestamp();
        
        // Coin flip results
        const results = ['Heads', 'Tails'];
        const randomResult = results[Math.floor(Math.random() * results.length)];
        
        // Create flip message
        const flipMessage = {
            username: "🪙 Coin Flip",
            text: `🎲 *flips coin* \n\n**${randomResult}!**`,
            timestamp: timestamp
        };
        
        // Store message (keep only last 20)
        messages.push(flipMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`Coin flip result: ${randomResult}`);
        
        // Broadcast flip result to all users
        io.emit('message', flipMessage);
    });

    // Handle roll command
    socket.on('roll', (data) => {
        const { number } = data;
        const timestamp = getLocalTimestamp();
        
        // Parse the number or default to 6
        const maxNumber = parseInt(number) || 6;
        const validMax = Math.min(Math.max(maxNumber, 2), 1000); // Between 2 and 1000
        
        const result = Math.floor(Math.random() * validMax) + 1;
        
        const rollMessage = {
            username: "🎲 Dice Roll",
            text: `🎯 *rolls a ${validMax}-sided die* \n\n**${result}!**`,
            timestamp: timestamp
        };
        
        messages.push(rollMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`Dice roll (1-${validMax}): ${result}`);
        io.emit('message', rollMessage);
    });

    // Handle quote command
    socket.on('quote', () => {
        const timestamp = getLocalTimestamp();
        
        const quotes = [
            "The only way to do great work is to love what you do. - Steve Jobs",
            "Innovation distinguishes between a leader and a follower. - Steve Jobs",
            "Life is what happens to you while you're busy making other plans. - John Lennon",
            "The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt",
            "It is during our darkest moments that we must focus to see the light. - Aristotle",
            "The way to get started is to quit talking and begin doing. - Walt Disney",
            "Don't let yesterday take up too much of today. - Will Rogers",
            "You learn more from failure than from success. Don't let it stop you. - Unknown",
            "If you are working on something that you really care about, you don't have to be pushed. - Steve Jobs",
            "Experience is a hard teacher because she gives the test first, the lesson afterwards. - Vernon Law",
            "To live is the rarest thing in the world. Most people just exist. - Oscar Wilde",
            "Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill",
            "The only impossible journey is the one you never begin. - Tony Robbins",
            "In the midst of winter, I found there was, within me, an invincible summer. - Albert Camus",
            "Be yourself; everyone else is already taken. - Oscar Wilde",
            "Two things are infinite: the universe and human stupidity; I'm not sure about the universe. - Albert Einstein",
            "Be the change you wish to see in the world. - Mahatma Gandhi",
            "A room without books is like a body without a soul. - Marcus Tullius Cicero",
            "You only live once, but if you do it right, once is enough. - Mae West",
            "Insanity is doing the same thing over and over again and expecting different results. - Albert Einstein"
        ];
        
        const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
        
        const quoteMessage = {
            username: "💭 Quote Bot",
            text: `✨ ${randomQuote}`,
            timestamp: timestamp
        };
        
        messages.push(quoteMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log('Quote command used');
        io.emit('message', quoteMessage);
    });

    // Handle time command
    socket.on('time', () => {
        const timestamp = getLocalTimestamp();
        
        const now = new Date();
        const localTime = getLocalTimestamp();
        
        // Display Central Time as your local time
        const localTimeDisplay = now.toLocaleTimeString('en-US', { 
            timeZone: 'America/Chicago', // Central Time Zone
            hour12: true,
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        
        const timeZones = [
            { name: 'Your Local Time (Central)', time: localTimeDisplay, highlight: true },
            { name: 'UTC', time: now.toISOString().slice(11, 19) + ' UTC' },
            { name: 'New York', time: now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true }) + ' EST/EDT' },
            { name: 'Los Angeles', time: now.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour12: true }) + ' PST/PDT' },
            { name: 'London', time: now.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour12: false }) + ' GMT/BST' },
            { name: 'Tokyo', time: now.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }) + ' JST' }
        ];
        
        const timeText = timeZones.map(tz => {
            if (tz.highlight) {
                return `🏠 **${tz.name}:** ${tz.time}`;
            }
            return `**${tz.name}:** ${tz.time}`;
        }).join('\n');
        
        const timeMessage = {
            username: "🕐 World Clock",
            text: `🌍 **Current Time Around the World:**\n\n${timeText}`,
            timestamp: timestamp
        };
        
        messages.push(timeMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log('Time command used');
        io.emit('message', timeMessage);
    });

    // Handle weather command
    socket.on('weather', async (data) => {
        const { city } = data;
        const timestamp = getLocalTimestamp();
        
        const cityName = city || 'Unknown Location';
        
        try {
            // Try OpenWeatherMap API first
            let response;
            let isOpenWeatherMap = true;
            
            try {
                response = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(cityName)}&appid=${WEATHER_API_KEY}&units=metric`);
            } catch (error) {
                // If OpenWeatherMap fails (likely invalid API key), try wttr.in as fallback
                console.log('OpenWeatherMap failed, trying fallback service...');
                isOpenWeatherMap = false;
                response = await axios.get(`https://wttr.in/${encodeURIComponent(cityName)}?format=j1`);
            }
            
            let weatherMessage;
            
            if (isOpenWeatherMap) {
                // Parse OpenWeatherMap response
                const weather = response.data;
                const temp = Math.round(weather.main.temp);
                const humidity = weather.main.humidity;
                const condition = weather.weather[0].description;
                const icon = weather.weather[0].main;
                
                // Map weather conditions to emojis
                const weatherEmojis = {
                    'Clear': '☀️',
                    'Clouds': '☁️',
                    'Rain': '🌧️',
                    'Drizzle': '🌦️',
                    'Thunderstorm': '⛈️',
                    'Snow': '❄️',
                    'Mist': '🌫️',
                    'Smoke': '🌫️',
                    'Haze': '🌫️',
                    'Dust': '🌫️',
                    'Fog': '🌫️',
                    'Sand': '🌫️',
                    'Ash': '🌫️',
                    'Squall': '💨',
                    'Tornado': '🌪️'
                };
                
                const emoji = weatherEmojis[icon] || '🌤️';
                
                weatherMessage = {
                    username: "🌤️ Weather Bot",
                    text: `🏙️ **Weather in ${weather.name}, ${weather.sys.country}:**\n\n🌡️ **Temperature:** ${temp}°C (${Math.round(temp * 9/5 + 32)}°F)\n🌈 **Condition:** ${condition.charAt(0).toUpperCase() + condition.slice(1)} ${emoji}\n💧 **Humidity:** ${humidity}%\n🌬️ **Wind:** ${Math.round(weather.wind.speed)} m/s\n📍 **Coordinates:** ${weather.coord.lat}, ${weather.coord.lon}`,
                    timestamp: timestamp
                };
            } else {
                // Parse wttr.in response (fallback service)
                const weather = response.data;
                const current = weather.current_condition[0];
                const location = weather.nearest_area[0];
                
                const temp = Math.round(current.temp_C);
                const humidity = current.humidity;
                const condition = current.weatherDesc[0].value;
                
                // Simple emoji mapping for wttr.in
                const getWeatherEmoji = (desc) => {
                    const lower = desc.toLowerCase();
                    if (lower.includes('sunny') || lower.includes('clear')) return '☀️';
                    if (lower.includes('cloud')) return '☁️';
                    if (lower.includes('rain')) return '🌧️';
                    if (lower.includes('storm')) return '⛈️';
                    if (lower.includes('snow')) return '❄️';
                    if (lower.includes('fog') || lower.includes('mist')) return '🌫️';
                    return '🌤️';
                };
                
                const emoji = getWeatherEmoji(condition);
                
                weatherMessage = {
                    username: "🌤️ Weather Bot",
                    text: `🏙️ **Weather in ${location.areaName[0].value}, ${location.country[0].value}:**\n\n🌡️ **Temperature:** ${temp}°C (${Math.round(temp * 9/5 + 32)}°F)\n🌈 **Condition:** ${condition} ${emoji}\n💧 **Humidity:** ${humidity}%\n🌬️ **Wind:** ${current.windspeedKmph} km/h\n\n💡 *Using backup weather service*`,
                    timestamp: timestamp
                };
            }
            
            messages.push(weatherMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            console.log(`Weather data retrieved for: ${cityName} (${isOpenWeatherMap ? 'OpenWeatherMap' : 'wttr.in'})`);
            io.emit('message', weatherMessage);
            
        } catch (error) {
            console.error('Weather API error:', error.message);
            
            let errorMessage = "Sorry, I couldn't fetch the weather data. ";
            
            if (error.response) {
                // API responded with error status
                if (error.response.status === 404) {
                    errorMessage += `City "${cityName}" not found. Please check the spelling and try again.`;
                } else if (error.response.status === 401) {
                    errorMessage += "Weather service is temporarily unavailable.";
                } else {
                    errorMessage += `Weather service error (${error.response.status}).`;
                }
            } else if (error.request) {
                // Request was made but no response received
                errorMessage += "Unable to connect to weather service. Please try again later.";
            } else {
                // Something else happened
                errorMessage += "An unexpected error occurred. Please try again.";
            }
            
            const errorWeatherMessage = {
                username: "🌤️ Weather Bot",
                text: `🏙️ **Weather Request for ${cityName}:**\n\n❌ ${errorMessage}\n\n💡 **Tip:** Try using a major city name like "New York", "London", or "Toronto".`,
                timestamp: timestamp
            };
            
            messages.push(errorWeatherMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            io.emit('message', errorWeatherMessage);
        }
    });

    // Handle trivia command
    socket.on('trivia', () => {
        const timestamp = getLocalTimestamp();
        
        const triviaQuestions = [
            { q: "What is the capital of Australia?", a: "Canberra" },
            { q: "How many hearts does an octopus have?", a: "Three" },
            { q: "What year was the first iPhone released?", a: "2007" },
            { q: "What is the largest planet in our solar system?", a: "Jupiter" },
            { q: "Who painted the Mona Lisa?", a: "Leonardo da Vinci" },
            { q: "What is the chemical symbol for gold?", a: "Au" },
            { q: "How many bones are in the human body?", a: "206" },
            { q: "What is the fastest land animal?", a: "Cheetah" },
            { q: "In which year did World War II end?", a: "1945" },
            { q: "What is the smallest country in the world?", a: "Vatican City" },
            { q: "How many strings does a standard guitar have?", a: "Six" },
            { q: "What is the largest ocean on Earth?", a: "Pacific Ocean" },
            { q: "Who wrote 'Romeo and Juliet'?", a: "William Shakespeare" },
            { q: "What is the hardest natural substance?", a: "Diamond" },
            { q: "How many minutes are in a full week?", a: "10,080" },
            { q: "What language is spoken in Brazil?", a: "Portuguese" },
            { q: "How many sides does a hexagon have?", a: "Six" },
            { q: "What is the currency of Japan?", a: "Yen" },
            { q: "Which planet is known as the Red Planet?", a: "Mars" },
            { q: "What does 'WWW' stand for?", a: "World Wide Web" }
        ];
        
        const randomTrivia = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
        const questionId = Date.now().toString(); // Simple unique ID
        
        // Store active trivia session
        activeTrivia.set(questionId, {
            question: randomTrivia.q,
            answer: randomTrivia.a.toLowerCase(),
            askedBy: socket.id,
            answeredBy: new Set(),
            timestamp: timestamp
        });
        
        const triviaMessage = {
            username: "🧠 Trivia Bot",
            text: `❓ **Trivia Question #${questionId.slice(-4)}:**\n\n${randomTrivia.q}\n\n💭 Type your answer in chat to guess! Anyone can answer.`,
            timestamp: timestamp
        };
        
        messages.push(triviaMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`Trivia question asked: ${randomTrivia.q}`);
        io.emit('message', triviaMessage);
        
        // Auto-reveal answer after 60 seconds if no one gets it right
        setTimeout(() => {
            if (activeTrivia.has(questionId)) {
                const session = activeTrivia.get(questionId);
                const revealMessage = {
                    username: "🧠 Trivia Bot",
                    text: `⏰ **Time's up!** Question #${questionId.slice(-4)}\n\n❓ ${session.question}\n✅ **Answer:** ${session.answer}\n\n🤔 Better luck next time! Use /trivia for another question.`,
                    timestamp: getLocalTimestamp()
                };
                
                messages.push(revealMessage);
                if (messages.length > maxMessages) {
                    messages.shift();
                }
                
                activeTrivia.delete(questionId);
                io.emit('message', revealMessage);
            }
        }, 60000); // 60 seconds
    });

    // Handle countdown command
    socket.on('countdown', (data) => {
        const { seconds } = data;
        const timestamp = getLocalTimestamp();
        
        const countdownSeconds = Math.min(Math.max(parseInt(seconds) || 10, 1), 300); // 1-300 seconds
        
        const countdownMessage = {
            username: "⏰ Countdown Timer",
            text: `🚀 **Countdown Started:** ${countdownSeconds} seconds\n\n⏳ Timer is running...`,
            timestamp: timestamp
        };
        
        messages.push(countdownMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`Countdown started: ${countdownSeconds} seconds`);
        io.emit('message', countdownMessage);
        
        // Send countdown completion message after specified time
        setTimeout(() => {
            const completeMessage = {
                username: "⏰ Countdown Timer",
                text: `🎉 **Time's Up!** The ${countdownSeconds}-second countdown has finished!`,
                timestamp: getLocalTimestamp()
            };
            
            messages.push(completeMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            io.emit('message', completeMessage);
        }, countdownSeconds * 1000);
    });

    // Handle random command
    socket.on('random', (data) => {
        const { min, max } = data;
        const timestamp = getLocalTimestamp();
        
        const minNum = parseInt(min) || 1;
        const maxNum = parseInt(max) || 100;
        
        // Ensure min is less than or equal to max
        const actualMin = Math.min(minNum, maxNum);
        const actualMax = Math.max(minNum, maxNum);
        
        const randomNumber = Math.floor(Math.random() * (actualMax - actualMin + 1)) + actualMin;
        
        const randomMessage = {
            username: "🎯 Random Number",
            text: `🔢 **Random number between ${actualMin} and ${actualMax}:**\n\n**${randomNumber}**`,
            timestamp: timestamp
        };
        
        messages.push(randomMessage);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`Random number generated: ${randomNumber} (${actualMin}-${actualMax})`);
        io.emit('message', randomMessage);
    });

    // Handle ChatGPT API key submission
    socket.on('submit chatgpt api key', async (data) => {
        const { apiKey, model } = data;
        const timestamp = getLocalTimestamp();
        
        try {
            // Test the API key by making a simple request
            const testClient = new OpenAI({ apiKey: apiKey });
            await testClient.models.list(); // Simple test request
            
            // If successful, store the API key and client
            chatGPTApiKey = apiKey;
            chatGPTEnabledBy = socket.id;
            openaiClient = testClient;
            selectedGPTModel = model || 'gpt-4o-mini'; // Use selected model or default
            
            console.log(`ChatGPT API enabled by user: ${socket.id} with model: ${selectedGPTModel}`);
            
            // Notify the user who submitted the key
            socket.emit('chatgpt api key status', { 
                success: true, 
                message: 'API key validated successfully! ChatGPT is now enabled for everyone.',
                isKeyProvider: true
            });
            
            // Notify all other users that ChatGPT is now available
            socket.broadcast.emit('chatgpt api key status', { 
                success: true, 
                message: 'ChatGPT is now available! Someone has provided an API key.',
                isKeyProvider: false
            });
            
            // Send announcement message to chat
            const announcementMessage = {
                username: "🤖 ChatGPT System",
                text: `✅ **ChatGPT is now ACTIVE!**\n\nUse \`/chatgpt [question]\` to ask ChatGPT anything!\n\n🛡️ **AI Moderation:** All messages will now be moderated by AI instead of basic profanity filter.\n\n🔧 The API provider can deactivate it anytime using the red button.`,
                timestamp: timestamp
            };
            
            messages.push(announcementMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            io.emit('message', announcementMessage);
            
        } catch (error) {
            console.error('Invalid ChatGPT API key:', error.message);
            socket.emit('chatgpt api key status', { 
                success: false, 
                message: 'Invalid API key. Please check your OpenAI API key and try again.',
                isKeyProvider: false
            });
        }
    });

    // Handle ChatGPT API deactivation
    socket.on('deactivate chatgpt api', () => {
        if (socket.id === chatGPTEnabledBy) {
            const timestamp = getLocalTimestamp();
            
            // Clear the API key and client
            chatGPTApiKey = null;
            chatGPTEnabledBy = null;
            openaiClient = null;
            chatGPTConversation = []; // Clear conversation history
            
            console.log(`ChatGPT API deactivated by user: ${socket.id}`);
            
            // Notify all users that ChatGPT has been deactivated
            io.emit('chatgpt api deactivated');
            
            // Send announcement message to chat
            const deactivationMessage = {
                username: "🤖 ChatGPT System",
                text: `❌ **ChatGPT has been DEACTIVATED**\n\nThe API provider has disabled ChatGPT access.\n\n🛡️ **Moderation:** Chat is now using basic profanity filter.\n\n🔑 To use ChatGPT again, someone needs to provide a new API key.`,
                timestamp: timestamp
            };
            
            messages.push(deactivationMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            io.emit('message', deactivationMessage);
        } else {
            socket.emit('error', { message: 'You are not authorized to deactivate ChatGPT.' });
        }
    });

    // Handle ChatGPT command
    socket.on('chatgpt', async (data) => {
        const { question, username } = data;
        const timestamp = getLocalTimestamp();
        
        // Check if API key is available
        if (!chatGPTApiKey || !openaiClient) {
            // Even without ChatGPT API, we should still moderate the question using basic filter
            if (filter.check(question)) {
                const profanityMessage = {
                    username: "System",
                    text: `${username}'s ChatGPT question was blocked for inappropriate content!`,
                    timestamp: timestamp
                };
                
                messages.push(profanityMessage);
                if (messages.length > maxMessages) {
                    messages.shift();
                }
                
                console.log(`Profanity filter blocked ChatGPT question from ${username}: ${question}`);
                io.emit('message', profanityMessage);
                return;
            }
            
            // Question is clean but no API key available
            socket.emit('chatgpt api key required');
            return;
        }
        
        // MODERATE THE CHATGPT QUESTION FIRST
        try {
            // Since ChatGPT is available, use AI moderation on the question
            const moderationResult = await openaiClient.chat.completions.create({
                model: selectedGPTModel,
                messages: [
                    {
                        role: "system",
                        content: "You are a chat moderator. Analyze the following ChatGPT question and determine if it contains inappropriate content (profanity, hate speech, harassment, harmful requests, or other inappropriate content). Respond with only 'SAFE' if the question is appropriate, or 'INAPPROPRIATE: [brief reason]' if it should be blocked. Be reasonable - don't block normal questions or mild language."
                    },
                    {
                        role: "user",
                        content: `ChatGPT question from user "${username}": "${question}"`
                    }
                ],
                max_tokens: 50,
                temperature: 0.1
            });
            
            const moderationResponse = moderationResult.choices[0].message.content.trim();
            
            if (moderationResponse.startsWith('INAPPROPRIATE')) {
                // AI detected inappropriate content in ChatGPT question
                const reason = moderationResponse.split(':')[1]?.trim() || 'inappropriate content';
                
                const aiModerationMessage = {
                    username: "🤖 AI Moderator",
                    text: `⚠️ **ChatGPT Request Blocked**\n\n${username}'s ChatGPT question was blocked for: ${reason}\n\n🔍 *AI moderation protects ChatGPT requests too*`,
                    timestamp: timestamp
                };
                
                messages.push(aiModerationMessage);
                if (messages.length > maxMessages) {
                    messages.shift();
                }
                
                console.log(`AI moderation blocked ChatGPT question from ${username}: ${reason}`);
                io.emit('message', aiModerationMessage);
                return; // Don't process the ChatGPT request
            }
            
            console.log(`AI moderation approved ChatGPT question from ${username}`);
            
        } catch (moderationError) {
            console.error('AI moderation error for ChatGPT question:', moderationError.message);
            // Fall back to basic profanity filter for ChatGPT questions
            if (filter.check(question)) {
                const profanityMessage = {
                    username: "System",
                    text: `${username}'s ChatGPT question was blocked for inappropriate content! (AI moderation unavailable, using backup filter)`,
                    timestamp: timestamp
                };
                
                messages.push(profanityMessage);
                if (messages.length > maxMessages) {
                    messages.shift();
                }
                
                console.log(`Backup profanity filter blocked ChatGPT question from ${username}: ${question}`);
                io.emit('message', profanityMessage);
                return;
            }
        }
        
        // Question passed moderation, now process ChatGPT request
        try {
            // Add user question to conversation history
            chatGPTConversation.push({
                role: "user",
                content: question
            });
            
            // Keep conversation history to last 10 messages to avoid token limits
            if (chatGPTConversation.length > 20) {
                chatGPTConversation = chatGPTConversation.slice(-20);
            }
            
            // Make request to OpenAI with conversation context
            const messages = [
                {
                    role: "system",
                    content: "You are a helpful assistant in a chat room. Keep responses concise and friendly. Limit responses to 500 characters or less when possible. Remember previous messages in this conversation."
                },
                ...chatGPTConversation
            ];
            
            const completion = await openaiClient.chat.completions.create({
                model: selectedGPTModel,
                messages: messages,
                max_tokens: 200,
                temperature: 0.7
            });
            
            const response = completion.choices[0].message.content.trim();
            
            // Add ChatGPT response to conversation history
            chatGPTConversation.push({
                role: "assistant",
                content: response
            });
            
            const chatGPTMessage = {
                username: "🤖 ChatGPT",
                text: `${username} told ChatGPT "${question}" - ChatGPT said "${response}"`,
                timestamp: timestamp
            };
            
            messages.push(chatGPTMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            console.log(`ChatGPT response generated for ${username}'s question: ${question}`);
            io.emit('message', chatGPTMessage);
            
        } catch (error) {
            console.error('ChatGPT API error:', error.message);
            
            const errorMessage = {
                username: "🤖 ChatGPT System",
                text: `❌ **Error processing your request**\n\nSorry, I encountered an error while processing: "${question}"\n\n🔧 This might be due to API limits or connectivity issues. Please try again later.`,
                timestamp: timestamp
            };
            
            messages.push(errorMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            io.emit('message', errorMessage);
        }
    });

    // Handle clear ChatGPT memory command (only for API provider)
    socket.on('clear chatgpt memory', () => {
        if (socket.id === chatGPTEnabledBy) {
            chatGPTConversation = [];
            
            const timestamp = getLocalTimestamp();
            const clearMessage = {
                username: "🤖 ChatGPT System",
                text: `🧠 **Memory Cleared**\n\nChatGPT's conversation history has been reset by the API provider.`,
                timestamp: timestamp
            };
            
            messages.push(clearMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            io.emit('message', clearMessage);
            console.log(`ChatGPT memory cleared by API provider: ${socket.id}`);
        } else {
            socket.emit('error', { message: 'You are not authorized to clear ChatGPT memory.' });
        }
    });

    // Handle clear messages
    socket.on('clear messages', () => {
        messages.length = 0; // Clear all messages
        io.emit('clear messages'); // Notify all clients
    });

    // Handle user leaving
    socket.on('leave', (data) => {
        const { username } = data;
        if (onlineUsers[username]) {
            delete onlineUsers[username];
            io.emit('user left', username);
            // Broadcast updated online users list
            io.emit('online users update', { onlineUsers: Object.keys(onlineUsers) });
        }
    });

    // Handle block user by IP
    socket.on('block user', (data) => {
        const { targetIP } = data;
        
        if (!userBlockedIPs.has(socket.id)) {
            userBlockedIPs.set(socket.id, new Set());
        }
        
        userBlockedIPs.get(socket.id).add(targetIP);
        
        // Send filtered messages (excluding blocked IPs) to the blocking user
        const filteredMessages = messages.filter(msg => 
            !userBlockedIPs.get(socket.id)?.has(msg.ip)
        );
        
        socket.emit('load messages', filteredMessages);
        socket.emit('user blocked', { blockedIP: targetIP });
        
        console.log(`User ${socket.id} blocked IP: ${targetIP}`);
    });

    // Handle unblock user by IP  
    socket.on('unblock user', (data) => {
        const { targetIP } = data;
        
        if (userBlockedIPs.has(socket.id)) {
            userBlockedIPs.get(socket.id).delete(targetIP);
            
            // If no more blocked IPs for this user, remove the entry
            if (userBlockedIPs.get(socket.id).size === 0) {
                userBlockedIPs.delete(socket.id);
            }
        }
        
        // Send all messages back to the user (no longer filtered)
        const filteredMessages = messages.filter(msg => 
            !userBlockedIPs.get(socket.id)?.has(msg.ip)
        );
        
        socket.emit('load messages', filteredMessages);
        socket.emit('user unblocked', { unblockedIP: targetIP });
        
        console.log(`User ${socket.id} unblocked IP: ${targetIP}`);
    });

    // Handle get blocked users list
    socket.on('get blocked users', () => {
        const blockedIPs = userBlockedIPs.get(socket.id) || new Set();
        socket.emit('blocked users list', { blockedIPs: Array.from(blockedIPs) });
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Remove user from online users list
        let disconnectedUsername = null;
        for (const [username, socketId] of Object.entries(onlineUsers)) {
            if (socketId === socket.id) {
                disconnectedUsername = username;
                delete onlineUsers[username];
                break;
            }
        }
        
        // Broadcast updated online users list
        if (disconnectedUsername) {
            io.emit('user left', disconnectedUsername);
            io.emit('online users update', { onlineUsers: Object.keys(onlineUsers) });
        }
        
        // Check if this user was the ChatGPT API provider
        if (socket.id === chatGPTEnabledBy) {
            const timestamp = getLocalTimestamp();
            
            console.log('ChatGPT API provider disconnected, deactivating ChatGPT');
            
            // Clear the API key and client
            chatGPTApiKey = null;
            chatGPTEnabledBy = null;
            openaiClient = null;
            chatGPTConversation = []; // Clear conversation history
            
            // Notify all users that ChatGPT has been deactivated
            io.emit('chatgpt api deactivated');
            
            // Send announcement message to chat
            const deactivationMessage = {
                username: "🤖 ChatGPT System",
                text: `❌ **ChatGPT has been DEACTIVATED**\n\nThe API provider has disconnected.\n\n🛡️ **Moderation:** Chat is now using basic profanity filter.\n\n🔑 To use ChatGPT again, someone needs to provide a new API key.`,
                timestamp: timestamp
            };
            
            messages.push(deactivationMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            io.emit('message', deactivationMessage);
        }
        
        // Clean up blocked IPs for this user
        userBlockedIPs.delete(socket.id);
        
        // Find and remove user from online users
        for (const [username, id] of Object.entries(onlineUsers)) {
            if (id === socket.id) {
                delete onlineUsers[username];
                io.emit('user left', username);
                break;
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check available at: http://localhost:${PORT}/health`);
}).on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});
