function serializeMessage(message) {
  if (!message) return null;
  if (!message.id) return message;

  return {
    id: message.id?._serialized ?? null,
    from: message.from,
    to: message.to,
    body: message.body,
    type: message.type,
    timestamp: message.timestamp,
    hasMedia: message.hasMedia,
    fromMe: message.fromMe,
  };
}

function serializeChat(chat) {
  return {
    id: chat.id._serialized,
    name: chat.name,
    isGroup: chat.isGroup,
    unreadCount: chat.unreadCount,
    timestamp: chat.timestamp,
    lastMessage: chat.lastMessage ? serializeMessage(chat.lastMessage) : null,
  };
}

function serializeContact(contact) {
  if (!contact) return null;

  return {
    id: contact.id?._serialized ?? null,
    name: contact.name ?? null,
    pushname: contact.pushname ?? null,
    number: contact.number ?? null,
    isBusiness: Boolean(contact.isBusiness),
    isMyContact: Boolean(contact.isMyContact),
    isBlocked: Boolean(contact.isBlocked),
  };
}

function serializeGroup(chat) {
  if (!chat?.id?._serialized) return null;

  return {
    id: chat.id._serialized,
    name: chat.name ?? chat.formattedTitle ?? 'Unnamed Group',
    isAnnouncement: Boolean(chat.isReadOnly),
    participants: chat.groupMetadata?.participants?.length ?? 0,
  };
}

module.exports = {
  serializeMessage,
  serializeChat,
  serializeContact,
  serializeGroup,
};
