export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          id: string
          ip_address: string | null
          request_id: string | null
          status_code: number | null
          timestamp: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          id?: string
          ip_address?: string | null
          request_id?: string | null
          status_code?: number | null
          timestamp?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          id?: string
          ip_address?: string | null
          request_id?: string | null
          status_code?: number | null
          timestamp?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_settings: {
        Row: {
          auto_reply: boolean
          enabled: boolean
          id: number
          model_name: string
          system_prompt: string
          updated_at: string
        }
        Insert: {
          auto_reply?: boolean
          enabled?: boolean
          id?: number
          model_name?: string
          system_prompt?: string
          updated_at?: string
        }
        Update: {
          auto_reply?: boolean
          enabled?: boolean
          id?: number
          model_name?: string
          system_prompt?: string
          updated_at?: string
        }
        Relationships: []
      }
      clients: {
        Row: {
          assigned_to: string
          created_at: string
          email: string | null
          full_name: string
          id: string
          id_photo_url: string | null
          id_validated: boolean
          inquiry_type: string
          last_service_date: string | null
          notes: string | null
          phone: string
          pipeline_stage: string | null
          poa_doc_url: string | null
          source_channel: string
          status: string
          updated_at: string
        }
        Insert: {
          assigned_to: string
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          id_photo_url?: string | null
          id_validated?: boolean
          inquiry_type: string
          last_service_date?: string | null
          notes?: string | null
          phone: string
          pipeline_stage?: string | null
          poa_doc_url?: string | null
          source_channel: string
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          id_photo_url?: string | null
          id_validated?: boolean
          inquiry_type?: string
          last_service_date?: string | null
          notes?: string | null
          phone?: string
          pipeline_stage?: string | null
          poa_doc_url?: string | null
          source_channel?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          bot_paused: boolean
          client_id: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          id: string
          last_message_at: string
          status: string
          whatsapp_chat_id: string
        }
        Insert: {
          bot_paused?: boolean
          client_id?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          last_message_at?: string
          status?: string
          whatsapp_chat_id: string
        }
        Update: {
          bot_paused?: boolean
          client_id?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          last_message_at?: string
          status?: string
          whatsapp_chat_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          client_id: string
          created_at: string
          file_name: string | null
          file_url: string
          id: string
          meeting_id: string | null
          mime_type: string | null
          type: string
          uploaded_by: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          file_name?: string | null
          file_url: string
          id?: string
          meeting_id?: string | null
          mime_type?: string | null
          type: string
          uploaded_by?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          file_name?: string | null
          file_url?: string
          id?: string
          meeting_id?: string | null
          mime_type?: string | null
          type?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          calendar_event_id: string | null
          client_confirmed: boolean
          client_id: string
          created_at: string
          id: string
          recording_url: string | null
          reminder_1h_sent: boolean
          reminder_24h_sent: boolean
          scheduled_at: string
          status: string
          summary_draft: string | null
          summary_final: string | null
          summary_status: string
          transcript: string | null
          type: string
          updated_at: string
        }
        Insert: {
          calendar_event_id?: string | null
          client_confirmed?: boolean
          client_id: string
          created_at?: string
          id?: string
          recording_url?: string | null
          reminder_1h_sent?: boolean
          reminder_24h_sent?: boolean
          scheduled_at: string
          status?: string
          summary_draft?: string | null
          summary_final?: string | null
          summary_status?: string
          transcript?: string | null
          type: string
          updated_at?: string
        }
        Update: {
          calendar_event_id?: string | null
          client_confirmed?: boolean
          client_id?: string
          created_at?: string
          id?: string
          recording_url?: string | null
          reminder_1h_sent?: boolean
          reminder_24h_sent?: boolean
          scheduled_at?: string
          status?: string
          summary_draft?: string | null
          summary_final?: string | null
          summary_status?: string
          transcript?: string | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string | null
          conversation_id: string
          created_at: string
          direction: string
          id: string
          message_type: string
          sent_by: string
          status: string
          whatsapp_message_id: string | null
        }
        Insert: {
          body?: string | null
          conversation_id: string
          created_at?: string
          direction: string
          id?: string
          message_type?: string
          sent_by: string
          status?: string
          whatsapp_message_id?: string | null
        }
        Update: {
          body?: string | null
          conversation_id?: string
          created_at?: string
          direction?: string
          id?: string
          message_type?: string
          sent_by?: string
          status?: string
          whatsapp_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          phone: string | null
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name: string
          id: string
          is_active?: boolean
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          phone?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          assigned_to: string
          client_id: string
          created_at: string
          description: string
          due_at: string
          id: string
          meeting_id: string | null
          parent_task_id: string | null
          reminder_sent: boolean
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          assigned_to: string
          client_id: string
          created_at?: string
          description: string
          due_at: string
          id?: string
          meeting_id?: string | null
          parent_task_id?: string | null
          reminder_sent?: boolean
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string
          client_id?: string
          created_at?: string
          description?: string
          due_at?: string
          id?: string
          meeting_id?: string | null
          parent_task_id?: string | null
          reminder_sent?: boolean
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_client_pipeline: {
        Row: {
          assigned_to: string | null
          created_at: string | null
          derived_stage: string | null
          email: string | null
          full_name: string | null
          id: string | null
          id_photo_url: string | null
          id_validated: boolean | null
          inquiry_type: string | null
          last_service_date: string | null
          latest_meeting_start_at: string | null
          notes: string | null
          open_tasks_count: number | null
          phone: string | null
          pipeline_stage: string | null
          poa_doc_url: string | null
          sla_breached: boolean | null
          source_channel: string | null
          status: string | null
          time_in_stage_hours: number | null
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string | null
          derived_stage?: never
          email?: string | null
          full_name?: string | null
          id?: string | null
          id_photo_url?: string | null
          id_validated?: boolean | null
          inquiry_type?: string | null
          last_service_date?: string | null
          latest_meeting_start_at?: never
          notes?: string | null
          open_tasks_count?: never
          phone?: string | null
          pipeline_stage?: string | null
          poa_doc_url?: string | null
          sla_breached?: never
          source_channel?: string | null
          status?: string | null
          time_in_stage_hours?: never
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          created_at?: string | null
          derived_stage?: never
          email?: string | null
          full_name?: string | null
          id?: string | null
          id_photo_url?: string | null
          id_validated?: boolean | null
          inquiry_type?: string | null
          last_service_date?: string | null
          latest_meeting_start_at?: never
          notes?: string | null
          open_tasks_count?: never
          phone?: string | null
          pipeline_stage?: string | null
          poa_doc_url?: string | null
          sla_breached?: never
          source_channel?: string | null
          status?: string | null
          time_in_stage_hours?: never
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
