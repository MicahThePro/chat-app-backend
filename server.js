const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const filter = require('leo-profanity');

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

// Store messages and online users
const messages = [];
const maxMessages = 20;
const onlineUsers = {};

// Serve static files from current directory
app.use(express.static(__dirname));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/room1', (req, res) => {
    res.sendFile(path.join(__dirname, 'room1.html'));
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle user joining
    socket.on('join', (data) => {
        const { username } = data;
        const userIP = socket.handshake.address;
        
        console.log(`User ${username} joined from IP: ${userIP}`);
        
        onlineUsers[username] = socket.id;
        
        // Broadcast user joined
        io.emit('user joined', username);
        
        // Send last 20 messages to new user
        socket.emit('load messages', messages);
    });    // Handle new messages
    socket.on('message', (msg) => {
        const timestamp = new Date().toLocaleString();
          // Check for profanity in the message
        if (filter.check(msg.text)) {
            // Send a message indicating profanity was attempted
            const profanityMessage = {
                username: "System",
                text: `${msg.username} tried to send a swear word!`,
                timestamp: timestamp
            };
            
            // Store the profanity warning message
            messages.push(profanityMessage);
            if (messages.length > maxMessages) {
                messages.shift();
            }
            
            console.log(`Profanity blocked from ${msg.username}: ${msg.text}`);
            
            // Broadcast the profanity warning to all users
            io.emit('message', profanityMessage);
            return; // Don't process the original message
        }
        
        const messageWithTimestamp = {
            ...msg,
            timestamp: timestamp
        };
        
        // Store message (keep only last 20)
        messages.push(messageWithTimestamp);
        if (messages.length > maxMessages) {
            messages.shift();
        }
        
        console.log(`Message from ${msg.username}: ${msg.text}`);
        
        // Broadcast message to all users
        io.emit('message', messageWithTimestamp);
    });// Handle 8-ball command
    socket.on('8ball', (data) => {
        const { question } = data;
        const timestamp = new Date().toLocaleString();
        
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
        const timestamp = new Date().toLocaleString();
        
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
        const timestamp = new Date().toLocaleString();
        
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
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
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
