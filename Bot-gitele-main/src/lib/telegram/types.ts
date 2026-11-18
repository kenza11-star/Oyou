export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
}

export interface TgMessage {
  chat: { id: number };
  from?: TgUser;
  text?: string;
  document?: TgDocument;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: { chat: { id: number }; message_id?: number };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
