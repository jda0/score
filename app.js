'use strict'

const request = require('request')
const AWS = require('aws-sdk')
const docClient = new AWS.DynamoDB.DocumentClient()

const table = 'Score'
const reserved_prefix = '_secret_'

console.log('Loading Messenger Bot')

exports.handler = function(event, context) {
    if (event.httpMethod === 'GET') {
        if (event.queryStringParameters !== null && event.queryStringParameters !== undefined && event.queryStringParameters['hub.mode'] === 'subscribe' && event.queryStringParameters['hub.verify_token'] ===  process.env.VERIFY_TOKEN) {
            context.succeed({
                statusCode: 200,
                body: event.queryStringParameters['hub.challenge']
            })
        } else {
            console.log('Unrecognised GET')
            context.succeed({ statusCode: 403 })
        }
    }

    if (event.httpMethod === 'POST') {
        let data = JSON.parse(event.body)

        if (event.body && data.object && data.object === 'page') {
            data.entry.forEach(function(entry) {
                entry.messaging.forEach(function(mevent, i, a) {
                    if (mevent.message)
                        receivedMessage(mevent, (i === a.length - 1) ? (() => context.succeed({ statusCode: 200 })) : null)
                    else {
                        console.warn('Unknown event: ', mevent)
                        context.succeed({ statusCode: 200 })
                    }    
                })
            }, this);
        } else {
            console.log('Unrecognised POST: ', event.body)
            context.succeed({ statusCode: 200 })
        }
    }
}

function receivedMessage(event, callback) {
    console.log('Received at %d from %d @ %d with message: %s', event.sender.id, event.recipient.id, event.timestamp, JSON.stringify(event.message, null, 2))

    if (event.message.text) {
        let words = event.message.text.split(' ')

        switch (words[0].toLowerCase()) {
            case 'give':
                giveScore(event.sender.id, words, callback)
                break
            case 'list': case 'show':
                listScores(event.sender.id, words, callback)
                break
            case 'remove': case 'delete':
                removePlayer(event.sender.id, words, callback)
                break
            default:
                console.log('Unknown verb %s in ', words[0].toLowerCase(), words)
                callSendAPI({
                    recipient: { id: event.sender.id },
                    message: { text: 'Sorry, I don\'t quite understand 🤔. Maybe try along the lines of "Give Jon 26 for Uno" or "List scores from Uno"?' }
                }, callback)
        }
    } else {
        console.log('Unknown message format')
        callSendAPI({
            recipient: { id: event.sender.id },
            message: { text: 'Sorry, I don\'t quite understand 🤔. Maybe try along the lines of "Give Jon 26 for Uno" or "List scores from Uno"?' }
        }, callback)
    }
}

function giveScore(sender, args, callback) {
    let target = '', score = NaN, groupIdx = -1
    if (args.length >= 5) {
        score = parseInt(args[2])
        groupIdx = args.findIndex(a => a.toLowerCase() === 'in' || a.toLowerCase() === 'for' || a.toLowerCase() === 'from')

        if (args[2].toLowerCase() === 'to') {
            score = parseInt(args[1])
            target = args[3]
        } else if (isNaN(score)) {
            score = parseInt(args[1])
            target = args[2]
        } else {
            target = args[1]
        }
    }

    target = target.toProperCase()
    let group = args[groupIdx + 1].toProperCase()

    if (isNaN(score) || groupIdx === -1) {
        console.log("giveScore parse failed")
        callSendAPI({
            recipient: { id: sender },
            message: { text: 'Sorry, I don\'t quite understand 🤔. Maybe try along the lines of "Give Jon 26 in Uno" or "Give -34 to Jack for Uno"?'}
        }, callback)
    } else {
        docClient.update({
            TableName: table,
            Key: {
                group,
                ident: target
            },
            UpdateExpression: 'ADD score :val, updates 1',
            ExpressionAttributeValues: { ':val': score },
            ReturnValues: 'UPDATED_NEW'
        }, function (err, data) {
            if (err) {
                console.log("Update failed: " + JSON.stringify(err, null, 2))
                callSendAPI({
                    recipient: { id: sender },
                    message: { text: 'Sorry, I had a problem whilst doing that 😢' }
                }, callback)
            } else {
                console.log("Gave %d to %s in %s", score, target, group)
                callSendAPI({
                    recipient: { id: sender },
                    message: { text: 'Done 👍' }
                }, callback)
            }
        })
    }
}

function listScores(sender, args, callback) {
    let groupIdx = 0

    if (args.length > 2)
        groupIdx = args.findIndex(a => a.toLowerCase() === 'in' || a.toLowerCase() === 'for' || a.toLowerCase() === 'from')
    
    if (groupIdx === -1 || args.length < 2) {
        console.log("listScores parse failed")
        callSendAPI({
            recipient: { id: sender },
            message: { text: 'Sorry, I don\'t quite understand 🤔. Maybe try along the lines of "List Uno" or "List scores for Uno"?'}
        }, callback)
    } else {
        let group = args[groupIdx + 1].toProperCase()

        docClient.query({
            TableName: table,
            KeyConditionExpression: "#g = :g",
            ExpressionAttributeNames: { '#g': 'group' },
            ExpressionAttributeValues: { ':g': group },
        }, function (err, data) {
            if (err) {
                console.log("List failed: " + JSON.stringify(err, null, 2))
                callSendAPI({
                    recipient: { id: sender },
                    message: { text: 'Sorry, I had a problem whilst doing that 😢' }
                }, callback)
            } else {
                console.log("List of %s succeeded", group)
                let list = data.Items.sort((a, b) => a.score < b.score).reduce((a, b) => a + '\n' + b.ident + '  ' + b.score + ' (' + b.writes + ')', '')
                if (list === '')
                    list = '... although there\'s nothing to show 💔'
                callSendAPI({
                    recipient: { id: sender },
                    message: { text: 'Here you go 👏\n' + list }
                }, callback)
            }
        })
    }
}

function removePlayer(sender, args, callback) {
    groupIdx = args.findIndex(a => a.toLowerCase() === 'in' || a.toLowerCase() === 'from')

    if (groupIdx = -1 || args.length < 4) {
        console.log("removePlayer parse failed")
        callSendAPI({
            recipient: { id: sender },
            message: { text: 'Sorry, I don\'t quite understand 🤔. Maybe try along the lines of "Delete Jon in Uno" or "Remove Jack from Uno"?'}
        }, callback)
    } else {
        let group = args[groupIdx + 1].toProperCase()
        let ident = args[1].toProperCase()

        docClient.delete({
            TableName: table,
            Key: {
                group,
                ident
            }
        }, function (err, data) {
            if (err) {
                console.log("Remove failed: " + JSON.stringify(err, null, 2))
                callSendAPI({
                    recipient: { id: sender },
                    message: { text: 'Sorry, I had a problem whilst doing that 😢' }
                }, callback)
            } else {
                console.log("Removed %s in %s", ident, group)
                callSendAPI({
                    recipient: { id: sender },
                    message: { text: 'Done 👍' }
                }, callback)
            }
        })
    }
}

function callSendAPI(messageData, callback) {
    if (!process.env.FB_PAGE_ACCESS_TOKEN)
        console.log("No Facebook Access Token provided in environment")
    else
        console.log("Sending message ", messageData)
        request({
            uri: 'https://graph.facebook.com/v2.6/me/messages',
            qs: { access_token: process.env.FB_PAGE_ACCESS_TOKEN },
            method: 'POST',
            json: messageData
        }, function (err, res, body) {
            if (!err && res.statusCode == 200) {
                console.log("Successfully sent message  ", body.recipient_id, body.message_id)
                typeof callback === 'function' && callback()
            } else {
                console.log("Unable to send message  ", res, err)
                typeof callback === 'function' && callback()
            }
        })
}

String.prototype.toProperCase = function () {
    return this.replace(/\w\S*/g, function (txt) {
        return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    })
}