require('dotenv').config();
console.log("Environment variables loaded.");

const { Web3 } = require('web3');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const path = require('path');
const express = require('express');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const mongoUri = process.env.MONGODB_URI;
const mongoClient = new MongoClient(mongoUri);

let db;
let crystalBallWins = {};
let winnersHistory = [];
let prizePercentage;
let tickets = [];

let blacklistedAddresses = process.env.BLACKLISTED_ADDRESSES.split(',');

selectWinner(tickets, blacklistedAddresses);

let usersCollection, crystalBallWinsCollection, prizeWinsCollection, appSettingsCollection;




async function connectMongoDB() {
    try {
        await mongoClient.connect();
        db = mongoClient.db();
        appSettingsCollection = db.collection('appSettings');
        usersCollection = db.collection('Users');
        crystalBallWinsCollection = db.collection('CrystalBallWins');
        prizeWinsCollection = db.collection('PrizeWins');
        await prizeWinsCollection.createIndex({ winner: 1, percentage: 1 }, { unique: true });
        console.log("Connected to MongoDB and collections set up");
    } catch (e) {
        console.error("Could not connect to MongoDB", e);
        process.exit(1);
    }
}


connectMongoDB();

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Endpoint to get the wallet balance
app.get('/api/wallet-balance', async (req, res) => {
    try {
        const balance = await fetchWalletBalance();
        res.json({ balance });
    } catch (error) {
        res.status(500).send('Error fetching wallet balance');
    }
});

// Endpoint to get the time until the next ball
app.get('/api/time-until-next', (req, res) => {
    const currentTime = new Date();
    const timeUntilNextBall = nextCrystalBallTime.getTime() - currentTime.getTime();

    if (timeUntilNextBall <= 0) {
        res.json({ minutes: 0, seconds: 0 });
    } else {
        const minutes = Math.floor(timeUntilNextBall / 60000);
        const seconds = Math.floor((timeUntilNextBall % 60000) / 1000);
        res.json({ minutes, seconds });
    }
});

app.get('/api/check-balls/:address', async (req, res) => {
    const address = req.params.address.toLowerCase(); // Convert the address to lowercase
    try {
        const result = await crystalBallWinsCollection.findOne({ address });
        const ballsCount = result ? result.wins : 0;

        // Shorten the address for display
        const shortenedAddress = `${address.substring(0, 5)}...${address.substring(address.length - 3)}`;

        // Create a string with the appropriate number of crystal ball emojis
        const ballsEmoji = '🔮'.repeat(ballsCount);

        const response = {
            address: shortenedAddress,
            balls: ballsEmoji
        };

        res.json(response);
    } catch (error) {
        console.error('Error fetching data from MongoDB:', error);
        res.status(500).send('Error fetching data');
    }
});



app.get('/api/previous-winners', async (req, res) => {
    try {
        const winnersData = await prizeWinsCollection.find({}).toArray();
        const winners = winnersData.map(item => ({
            winner: item.winner,
            percentage: item.percentage // Ensure this field exists in your MongoDB documents
        }));
        res.json({ winners });
    } catch (error) {
        console.error('Error fetching previous winners from MongoDB:', error);
        res.status(500).send('Error fetching data');
    }
});


async function getInitialDistributionCount() {
    const settings = await appSettingsCollection.findOne({ setting: 'initialDistributionCount' });
    return settings ? settings.value : 0;
}

async function updateInitialDistributionCount(newCount) {
    await appSettingsCollection.updateOne(
        { setting: 'initialDistributionCount' },
        { $set: { value: newCount } },
        { upsert: true }
    );
}

(async () => {
    await connectMongoDB();
    initialDistributionCount = await getInitialDistributionCount();
    console.log("Initial distribution count:", initialDistributionCount);
})();


let crystalBallHolders = {};
let nextCrystalBallTime = new Date();
nextCrystalBallTime.setMinutes(nextCrystalBallTime.getMinutes() + 30); // Set to 30 minutes from the current time

async function loadCrystalBallWins() {
    try {
        const winsData = await crystalBallWinsCollection.find({}).toArray();
        crystalBallWins = {}; // Resetting the object
        winsData.forEach(item => {
            // Only add non-blacklisted addresses
            if (!item.blacklisted) {
                crystalBallWins[item.address] = item.wins;
            }
        });

        console.log("Data loaded from MongoDB, excluding blacklisted addresses.");

        // Logging to confirm correct data synchronization
        console.log("Current non-blacklisted crystal ball wins:", crystalBallWins);
    } catch (error) {
        console.error('Error loading data from MongoDB:', error);
    }
}



const { ObjectId } = require('mongodb');

async function saveWinnersHistory() {
    try {
        for (const winner of winnersHistory) {
            // Generate a new ObjectId for each document
            winner._id = new ObjectId();

            try {
                await prizeWinsCollection.insertOne(winner);
            } catch (error) {
                if (error.code === 11000) { // Duplicate key error code
                    console.log('Duplicate entry found and skipped:', winner);
                    // Skipping the insertion of duplicate entry
                } else {
                    throw error; // Rethrow error if it's not a duplicate key error
                }
            }
        }
        console.log("Winners history updated in MongoDB.");
    } catch (error) {
        console.error('Error updating winners history in MongoDB:', error);
    }
}


function shortenAddress(address) {
    return `${address.substring(0, 5)}...${address.substring(address.length - 3)}`;
}

function getRankEmoji(index) {
    switch (index) {
        case 0: return '🥇';
        case 1: return '🥈';
        case 2: return '🥉';
        default: return `  ${index + 1}.`;
    }
}

async function filterBlacklistedAddresses() {
    console.log("Starting blacklist filtering process...");

    const blacklistedAddressesArray = process.env.BLACKLISTED_ADDRESSES.split(',')
                                       .map(addr => addr.trim().toLowerCase()); // Normalize to lowercase

    console.log("Normalized blacklisted addresses:", blacklistedAddressesArray);

    try {
        const blacklistedRegexArray = blacklistedAddressesArray.map(addr => new RegExp(`^${addr}$`, 'i'));

        const crystalBallUpdateResult = await crystalBallWinsCollection.updateMany(
            { address: { $in: blacklistedRegexArray } },
            { $set: { blacklisted: true } }
        );
        console.log("Updated CrystalBallWinsCollection:", crystalBallUpdateResult);

        const prizeWinsUpdateResult = await prizeWinsCollection.updateMany(
            { winner: { $in: blacklistedRegexArray } },
            { $set: { blacklisted: true } }
        );
        console.log("Updated PrizeWinsCollection:", prizeWinsUpdateResult);

        console.log("Blacklisted addresses filtered in MongoDB successfully.");
    } catch (error) {
        console.error('Error filtering blacklisted addresses in MongoDB:', error);
    }
}




console.log("Modules imported.");

if (!process.env.INFURA_URL) {
    console.error("INFURA_URL is not set in .env file.");
    process.exit(1);
}

const web3 = new Web3(process.env.INFURA_URL);
console.log("Web3 initialized.");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
console.log("Telegram bot initialized.");

function updateNextCrystalBallTime() {
    nextCrystalBallTime = new Date();
    nextCrystalBallTime.setMinutes(nextCrystalBallTime.getMinutes() + 30);
}

async function fetchTokenHolders() {
    try {
        console.log("Fetching token holders for crystal ball distribution...");

        const blacklistedResults = await crystalBallWinsCollection.find({ blacklisted: true }).toArray();
        const blacklistedAddresses = blacklistedResults.map(item => item.address.toLowerCase());

        let page = 0;
        const pageSize = 100;
        let allHolders = [];

        while (true) {
            console.log(`Fetching page ${page} of token holders...`);
            const chainId = '56';
            const contractAddress = '0x352263db8c84bD5EC6a7CE28883062141BfB13C0';
            const covalentApiKey = process.env.COVALENT_API_KEY;
            const url = `https://api.covalenthq.com/v1/${chainId}/tokens/${contractAddress}/token_holders/?key=${covalentApiKey}&page-size=${pageSize}&page-number=${page}`;
            const response = await axios.get(url);
            const data = response.data;

            if (!data || !data.data || !data.data.items) {
                throw new Error('Invalid data format received from Covalent API');
            }

            const holders = data.data.items.map(holder => ({
                ...holder,
                address: holder.address.toLowerCase()
            }));

            allHolders = allHolders.concat(holders);
            console.log(`Fetched ${holders.length} holders on page ${page}`);
            page++;

            if (holders.length < pageSize) {
                console.log("No more pages to fetch. Exiting the loop.");
                break;
            }
        }

        console.log(`Total holders fetched: ${allHolders.length}`);
        return allHolders;
    } catch (error) {
        console.error('Error fetching token holders:', error);
        return [];
    }
}

async function fetchAndSaveTokenHolders() {
    try {
        const holders = await fetchTokenHolders(); //Existing function to fetch token holders
        await db.collection('TokenHolders').deleteMany({}); // Clear existing data
        await db.collection('TokenHolders').insertMany(holders.map(holder => ({
            address: holder.address.toLowerCase(), // Normalize the address
            tokens: holder.balance // Assuming balance is the token count
        })));
        console.log("Token holders saved to database.");
    } catch (error) {
        console.error('Error in fetchAndSaveTokenHolders:', error);
    }
}

async function deleteBlacklistedHolders() {
    try {
        const blacklistedAddressesArray = process.env.BLACKLISTED_ADDRESSES.split(',')
                                           .map(addr => addr.toLowerCase());
        await db.collection('TokenHolders').deleteMany({
            address: { $in: blacklistedAddressesArray }
        });
        console.log("Blacklisted holders removed from database.");
    } catch (error) {
        console.error('Error in deleteBlacklistedHolders:', error);
    }
}


async function selectWinnerFromDB() {
    try {
        const holders = await db.collection('TokenHolders').find({}).toArray();
        let totalTokens = holders.reduce((total, holder) => total + BigInt(holder.tokens), BigInt(0));

        console.log("Total Tokens:", totalTokens.toString());
        console.log("Number of Holders:", holders.length);

        if (totalTokens <= BigInt(0)) {
            console.log("No valid tickets available.");
            return null;
        }

        let randomTokenNumber = BigInt(Math.floor(Math.random() * Number(totalTokens)));
        let cumulativeTotal = BigInt(0);

        for (const holder of holders) {
            cumulativeTotal += BigInt(holder.tokens);
            if (randomTokenNumber <= cumulativeTotal) {
                console.log("Winner selected:", holder.address);
                console.log("Winning Token Number:", randomTokenNumber.toString());
                console.log("Cumulative Total at Selection:", cumulativeTotal.toString());
                return holder.address;
            }
        }

        console.error("No winner could be selected.");
        return null;
    } catch (error) {
        console.error('Error in selectWinnerFromDB:', error);
        return null;
    }
}



async function fetchWalletBalance() {
    try {
        // Log the address for debugging
        console.log(`Fetching balance for address: ${process.env.SENDER_ADDRESS}`);

        // Check if the address is defined
        if (!process.env.SENDER_ADDRESS) {
            throw new Error('SENDER_ADDRESS is not defined in the environment variables.');
        }

        const balanceWei = await web3.eth.getBalance(process.env.SENDER_ADDRESS);
        return web3.utils.fromWei(balanceWei, 'ether');

    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        console.error('Error fetching token holders:', error);
        return 'Error fetching balance';
    }
}

function calculateTickets(holders) {
    console.log(`Calculating tickets for ${holders.length} holders.`);

    const tickets = {};
    let validHoldersCount = 0;
    for (const holder of holders) {
        if (holder.balance > 0) {
            tickets[holder.address] = holder.balance;
            validHoldersCount++;
        }
    }

    console.log(`Tickets calculated for ${validHoldersCount} valid holders out of ${holders.length} total.`);
    return tickets;
}



function selectWinner(tickets, blacklistedAddresses) {
    // Normalize the blacklistedAddresses to lower case
    blacklistedAddresses = (blacklistedAddresses || []).map(addr => addr.toLowerCase());

    // Filter out blacklisted addresses and convert balances to numbers
    let validTickets = Object.entries(tickets)
                             .filter(([address]) => !blacklistedAddresses.includes(address.toLowerCase()))
                             .map(([address, balance]) => [address, Number(balance)]);

    // Calculate the total number of tokens
    let totalTokens = validTickets.reduce((total, [_, balance]) => total + balance, 0);

    if (totalTokens <= 0) {
        console.log("No valid tickets available.");
        return null;
    }

    // Generate a random number between 0 and totalTokens
    let randomTokenNumber = Math.random() * totalTokens;

    // Iterate through the valid tickets to find the winner
    let cumulativeTotal = 0;
    for (const [address, balance] of validTickets) {
        cumulativeTotal += balance;
        if (randomTokenNumber <= cumulativeTotal) {
            console.log("Winner selected:", address);
            return address;
        }
    }

    // In case no winner is found (should not happen in theory), log an error
    console.error("No winner could be selected.");
    return null;
}


// Function to send an announcement message
async function sendAnnouncement(winner, ballsCount, prizePercentage, txId = null) {
    let message, imageUrl;
    const shortenedWinner = shortenAddress(winner);
    switch (ballsCount) {
        case 1:
            imageUrl = "https://i.ibb.co/zJ22FG8/DALL-E-2023-12-05-16-50-19-A-single-pink-crystal-ball-inspired-by-Lucky-Lady-s-charm-casino-game-wit.png"; // Replace with your actual URL
            message = `Congratulations ${shortenedWinner}!\nYou are now holding 1 crystal ball!`;
            break;
        case 2:
            imageUrl = "https://i.ibb.co/0tqJQgg/DALL-E-2023-12-05-16-50-16-Two-pink-crystal-balls-inspired-by-Lucky-Lady-s-charm-casino-game-with-a.png"; // Replace with your actual URL
            message = `Congratulations ${shortenedWinner}!\nYou are now holding 2 crystal balls!`;
            break;
        case 3:
            imageUrl = "https://i.ibb.co/X51N3PN/DALL-E-2023-12-05-16-50-13-Three-pink-crystal-balls-inspired-by-Lucky-Lady-s-charm-casino-game-arran.png";
            if (txId) {
                message = `🎉 Congratulations to ${shortenedWinner}! You've won ${prizePercentage.toFixed(2)}% of the prize! 🎉\nTransaction ID: ${txId}`;
            } else {
                message = `There was an issue with the transaction for ${shortenedWinner}. Please contact support.`;
            }
            break;
        default:
            console.error("Invalid number of crystal balls for announcement.");
            return;
    }
    await bot.sendPhoto(process.env.ANNOUNCEMENT_CHAT_ID, imageUrl, { caption: message });
}

let initialDistributionCount = 0;
const INITIAL_DISTRIBUTION_LIMIT = 50;

async function distributeCrystalBall() {
    console.log("Starting distribution process...");

    // Fetch and save token holders to the database, then remove blacklisted addresses
    await fetchAndSaveTokenHolders();
    await deleteBlacklistedHolders();

    if (initialDistributionCount >= INITIAL_DISTRIBUTION_LIMIT) {
        console.log("Regular distribution...");

        // Select a winner from the database
        const winner = await selectWinnerFromDB();
        if (!winner) {
            console.log("No winner selected, skipping distribution.");
            return;
        }

        const currentWins = await getWinsForAddress(winner);
        await recordWinForAddress(winner, currentWins);

        if (currentWins + 1 === 3) {
            console.log(`Distributing prize to ${winner} who has collected 3 crystal balls.`);
            prizePercentage = Math.random() * (100 - 25) + 25;

            let txHash = null;
            try {
                console.log("Initiating prize transaction...");
                txHash = await sendTransaction(winner, prizePercentage / 100);
                if (txHash) {
                    console.log(`Prize transaction successful with hash: ${txHash}`);
                    await recordWinForAddress(winner, -1); // Reset to 0
                } else {
                    console.log('Prize transaction failed or was not sent. Resetting win count.');
                    await recordWinForAddress(winner, -1); // Reset to 0
                }
            } catch (error) {
                console.error(`Error during prize transaction: ${error}`);
                await recordWinForAddress(winner, -1); // Reset to 0 in case of exception
            }

            winnersHistory.push({
                winner: winner,
                percentage: parseFloat(prizePercentage.toFixed(2)),
                txHash: txHash
            });
            console.log(`Winner added to history: ${winner}, Percentage: ${prizePercentage.toFixed(2)}, txHash: ${txHash}`);
            await saveWinnersHistory();
            await sendAnnouncement(winner, 3, prizePercentage, txHash);
        } else {
            console.log(`Announcing distribution for ${currentWins + 1} crystal ball(s) to ${winner}...`);
            await sendAnnouncement(winner, currentWins + 1, prizePercentage);
        }

        updateNextCrystalBallTime();
    } else {
        console.log("Initial distribution...");

        // Fetch token holders from the database (filtered and non-blacklisted)
        const holders = await db.collection('TokenHolders').find({}).toArray();

        if (holders.length === 0) {
            console.log("No token holders found, skipping initial distribution.");
            return;
        }

        for (const holder of holders.slice(0, INITIAL_DISTRIBUTION_LIMIT - initialDistributionCount)) {
            await recordWinForAddress(holder.address, 0);
            console.log(`Initial distribution: Awarded 1 crystal ball to ${holder.address}`);
            initialDistributionCount++;
            if (initialDistributionCount >= INITIAL_DISTRIBUTION_LIMIT) {
                break;
            }
        }

        await updateInitialDistributionCount(initialDistributionCount);
    }
}



async function getWinsForAddress(address) {
    try {
        const result = await crystalBallWinsCollection.findOne({ address });
        return result ? result.wins : 0;
    } catch (error) {
        console.error('Error fetching wins for address:', error);
        return 0;
    }
}

async function recordWinForAddress(address, currentWins) {
    try {
        let newWins = currentWins >= 0 ? currentWins + 1 : 0; // Increment or reset to 0
        await crystalBallWinsCollection.updateOne(
            { address },
            { $set: { wins: newWins } },
            { upsert: true }
        );
    } catch (error) {
        console.error('Error recording win for address:', error);
    }
}



async function sendTransaction(winner, prizePercentage) {
    try {
        const winnerChecksummed = web3.utils.toChecksumAddress(winner);
        console.log(`Sending transaction to winner: ${winnerChecksummed}`);

        const balance = BigInt(await web3.eth.getBalance(process.env.SENDER_ADDRESS));
        console.log(`Balance: ${balance}`);

        if (balance === BigInt(0)) {
            const announcementMessage = 'Announcement: Insufficient funds for prize distribution. Balance is zero!';
            console.log(announcementMessage);

            // Send message to the specified chat
            await bot.sendMessage(process.env.ANNOUNCEMENT_CHAT_ID, announcementMessage, { parse_mode: 'Markdown' });

            return null;
        }

        const estimatedGas = BigInt(21000);
        const gasPrice = BigInt(await web3.eth.getGasPrice());
        console.log(`Gas Estimate: ${estimatedGas}, Gas Price: ${gasPrice}`);

        const prizePercentageValue = Number(prizePercentage);
        console.log(`Prize Percentage: ${prizePercentageValue}`);

        const prizeAmount = BigInt(Math.round(prizePercentageValue * Number(balance)));
        console.log(`Prize Amount: ${prizeAmount}`);

        const gasCost = BigInt(estimatedGas * gasPrice);
        console.log(`Gas Cost: ${gasCost}`);

        const valueToSend = prizeAmount - gasCost;  // No need to convert to BigInt here
        console.log(`Calculated value to send: ${valueToSend}`);

        if (valueToSend <= BigInt(0)) {
            console.log(`Insufficient balance to send transaction to ${winnerChecksummed}.`);
            return null;
        }

        const transaction = {
            to: winnerChecksummed,
            value: valueToSend.toString(),
            gas: estimatedGas,
            gasPrice: gasPrice,
            nonce: BigInt(await web3.eth.getTransactionCount(process.env.SENDER_ADDRESS)),
            chainId: 56
        };

        console.log('Sending transaction:', transaction);

        const signedTransaction = await web3.eth.accounts.signTransaction(transaction, process.env.PRIVATE_KEY);
        console.log('Transaction signed.');

        const receipt = await web3.eth.sendSignedTransaction(signedTransaction.rawTransaction);
        console.log('Transaction sent successfully:', receipt);

        return receipt.transactionHash;
    } catch (error) {
        console.error(`Error sending transaction: ${error}`);
        console.error(error.reason); // Check if there's a reason for the revert
        return null;
    }
}

// Add this email validation function near the top of your file
function isValidEmail(email) {
    const re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(String(email).toLowerCase());
}

// Assuming 'db' is accessible here
// Add the /connect command handler where you have other bot commands
bot.onText(/\/email (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const email = match[1].trim();
    const tgUsername = msg.from.username || msg.from.id; // Use username or user ID if username is not set

    // Validate the email format
    if (!isValidEmail(email)) {
        await bot.sendMessage(chatId, "Please provide a valid email address.");
        return;
    }

    try {
        
        const existingUser = await db.collection('Users').findOne({ tgUsername: tgUsername });

        if (existingUser) {
            // Update the existing user's email
            await db.collection('Users').updateOne(
                { tgUsername: tgUsername },
                { $set: { email: email } }
            );
        } else {
            // Insert new user
            await db.collection('Users').insertOne({ tgUsername: tgUsername, email: email });
        }

        // Send confirmation message
        await bot.sendMessage(chatId, "Your email address has been successfully connected!");
    } catch (error) {
        console.error('Error in /connect command:', error);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});


bot.onText(/\/wen/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const currentTime = new Date();
        let timeUntilNextBall = nextCrystalBallTime.getTime() - currentTime.getTime();

        if (timeUntilNextBall <= 0) {
            // This means the distribution should be happening now
            await bot.sendMessage(chatId, "The next crystal ball distribution is happening now!");
            return;
        }

        // Convert milliseconds to minutes and seconds
        const minutes = Math.floor(timeUntilNextBall / 60000);
        const seconds = Math.floor((timeUntilNextBall % 60000) / 1000);

        const reply = `Time until next ball is ${minutes} minutes and ${seconds} seconds.`;
        await bot.sendMessage(chatId, reply);

        console.log("Replied to /time command.");
    } catch (error) {
        console.error(`Error in /time command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});


bot.onText(/\/balls/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        // Fetch crystal ball wins from the database
        const ballWins = await crystalBallWinsCollection.find({}).toArray();

        // Filter out blacklisted addresses
        const filteredBallWins = ballWins.filter(ballWin => !ballWin.blacklisted);

        let sortedBallWins = filteredBallWins.sort((a, b) => b.wins - a.wins).slice(0, 15);

        let reply = '🔮 Top 15 Crystal Ball Counts 🔮\n\n';
        sortedBallWins.forEach((item, index) => {
            reply += `${getRankEmoji(index)} ${shortenAddress(item.address)} - ${'🔮'.repeat(item.wins)}\n`;
        });

        await bot.sendMessage(chatId, reply);
        console.log("Replied to /balls command.");
    } catch (error) {
        console.error(`Error in /balls command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});



bot.onText(/\/prize/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const balance = await fetchWalletBalance();
        const reply = `Current wallet holding: ${balance} BNB`;
        await bot.sendMessage(chatId, reply);
        console.log("Replied to /prize command.");
    } catch (error) {
        console.error(`Error in /prize command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});

bot.onText(/\/winners/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        console.log("Handling /winners command");

        const winnersData = await prizeWinsCollection.find({}).toArray();
        console.log("winnersData from DB:", winnersData);

        let sortedWinners = winnersData.sort((a, b) => b.percentage - a.percentage).slice(0, 15);
        console.log("sortedWinners:", sortedWinners);

        let reply = '🏆 Top 15 Winners 🏆\n\n';
        sortedWinners.forEach((record, index) => {
            console.log(`Record ${index}:`, record); // Log each record
            console.log(`Data type of percentage for record ${index}:`, typeof record.percentage); // Log data type of percentage

            const roundedPercentage = parseFloat(record.percentage).toFixed(2);
            reply += `${getRankEmoji(index)} ${shortenAddress(record.winner)} - ${roundedPercentage}%\n`;
        });

        if (sortedWinners.length === 0) {
            reply = "No winners recorded yet.";
        }

        await bot.sendMessage(chatId, reply);
    } catch (error) {
        console.error(`Error in /winners command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});





bot.onText(/\/check (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    try {
        const address = match[1].toLowerCase(); // Ensure the address is in lowercase for consistent querying
        const result = await crystalBallWinsCollection.findOne({ address: address });
        const count = result ? result.wins : 0; // Use the count from the database, default to 0 if not found

        // Shorten the address for display
        const shortenedAddress = `${address.substring(0, 5)}...${address.substring(address.length - 3)}`;

        // Create a string with the appropriate number of crystal ball emojis
        const ballsEmoji = '🔮'.repeat(count);

        const reply = `${shortenedAddress} - ${ballsEmoji}`;
        await bot.sendMessage(chatId, reply);
        console.log("Replied to /check command.");
    } catch (error) {
        console.error(`Error in /check command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});


bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        console.log("Received /help command");

        const image_url = 'https://i.ibb.co/RTLR4qp/DALL-E-2023-12-05-18-52-09-An-artwork-for-a-help-handler-in-a-Telegram-group-styled-similarly-to-the.png';
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Balls', callback_data: 'top_10_balls' },
                        { text: 'Wen', callback_data: 'time_until_next' },
                    ],
                    [
                        { text: 'Prize', callback_data: 'wallet_balance' },
                        { text: 'Wins', callback_data: 'top_10_winners' },
                    ],
                ],
            },
        };

        await bot.sendPhoto(chatId, image_url, { caption: '', reply_markup: options.reply_markup });
        console.log("Replied to /help command with photo and options.");
    } catch (error) {
        console.error(`Error in /help command: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});


bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;

    try {
        console.log("Received callback query:", query.data);

        switch (query.data) {
            case 'top_10_balls':
                console.log("Handling top_10_balls button");
                const ballWins = await crystalBallWinsCollection.find({}).toArray();
                let sortedBallWins = ballWins.sort((a, b) => b.wins - a.wins).slice(0, 15);

                let ballsReply = '🔮 Top 15 Crystal Ball Counts 🔮\n\n';
                sortedBallWins.forEach((item, index) => {
                    ballsReply += `${getRankEmoji(index)} ${shortenAddress(item.address)} - ${'🔮'.repeat(item.wins)}\n`;
                });

                await bot.sendMessage(chatId, ballsReply);
                break;

            case 'time_until_next':
                console.log("Handling time_until_next button");
                const currentTime = new Date();
                const timeUntilNextBall = nextCrystalBallTime.getTime() - currentTime.getTime();
                const minutes = Math.floor(timeUntilNextBall / 60000);
                const seconds = Math.floor((timeUntilNextBall % 60000) / 1000);
                const timeReply = `Time until next ball is ${minutes} minutes and ${seconds} seconds.`;
                await bot.answerCallbackQuery(query.id, { text: timeReply });
                break;

            case 'wallet_balance':
                console.log("Handling wallet_balance button");
                const balance = await fetchWalletBalance();
                const balanceReply = `Current wallet holding: ${balance} BNB`;
                await bot.answerCallbackQuery(query.id, { text: balanceReply });
                break;

            case 'top_10_winners':
                console.log("Handling top_10_winners button");
                
                const winnersData = await prizeWinsCollection.find({}).toArray();
                console.log("winnersData from DB:", winnersData);

                let sortedWinners = winnersData.sort((a, b) => b.percentage - a.percentage).slice(0, 15);
                console.log("sortedWinners:", sortedWinners);

                let winnersReply = '🏆 Top 15 Winners 🏆\n\n';
                sortedWinners.forEach((record, index) => {
                    const roundedPercentage = parseFloat(record.percentage).toFixed(2);
                    winnersReply += `${getRankEmoji(index)} ${shortenAddress(record.winner)} - ${roundedPercentage}%\n`;
                });

                if (sortedWinners.length === 0) {
                    winnersReply = "No winners recorded yet.";
                }

                await bot.sendMessage(chatId, winnersReply);
                break;
        }
    } catch (error) {
        console.error(`Error in handling callback query: ${error}`);
        await bot.sendMessage(chatId, "An error occurred while processing your request.");
    }
});



async function main() {
    console.log("Starting main function.");

    // Connect to MongoDB and load data
    await connectMongoDB();
    await loadCrystalBallWins(); 

    // Schedule the crystal ball distribution task
    cron.schedule('*/30 * * * *', () => {
        console.log("Scheduled crystal ball distribution task triggered.");

        // Update next distribution time immediately
        updateNextCrystalBallTime();

        distributeCrystalBall();
    });

    // Start the Telegram bot polling
    if (!bot.isPolling()) {
        console.log("Starting bot polling...");
        bot.startPolling();
        console.log("Bot polling started.");
    } else {
        console.log("Bot is already polling. No need to start again.");
    }
}

main().catch(error => {
    console.error('Error in main function:', error);
});
