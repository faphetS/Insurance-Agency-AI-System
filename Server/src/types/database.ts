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
      bafi_agents: {
        Row: {
          address: string | null
          agency_name: string | null
          agent_number: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          agency_name?: string | null
          agent_number?: string | null
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          agency_name?: string | null
          agent_number?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      bafi_documents: {
        Row: {
          client_id: string
          created_at: string
          document_type: string | null
          file_name: string
          id: string
          policy_id: string | null
          storage_path: string | null
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          document_type?: string | null
          file_name: string
          id?: string
          policy_id?: string | null
          storage_path?: string | null
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          document_type?: string | null
          file_name?: string
          id?: string
          policy_id?: string | null
          storage_path?: string | null
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bafi_documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_documents_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      bafi_elementary_collection: {
        Row: {
          agent_number: string | null
          bafi_agent_id: string | null
          balance: number | null
          client_id: string
          created_at: string
          credit: number | null
          debit: number | null
          doc_number: string | null
          id: string
          insurance_company_id: string | null
          notes: string | null
          payment_date: string | null
          payment_type: string | null
          policy_id: string | null
          updated_at: string
        }
        Insert: {
          agent_number?: string | null
          bafi_agent_id?: string | null
          balance?: number | null
          client_id: string
          created_at?: string
          credit?: number | null
          debit?: number | null
          doc_number?: string | null
          id?: string
          insurance_company_id?: string | null
          notes?: string | null
          payment_date?: string | null
          payment_type?: string | null
          policy_id?: string | null
          updated_at?: string
        }
        Update: {
          agent_number?: string | null
          bafi_agent_id?: string | null
          balance?: number | null
          client_id?: string
          created_at?: string
          credit?: number | null
          debit?: number | null
          doc_number?: string | null
          id?: string
          insurance_company_id?: string | null
          notes?: string | null
          payment_date?: string | null
          payment_type?: string | null
          policy_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bafi_elementary_collection_bafi_agent_id_fkey"
            columns: ["bafi_agent_id"]
            isOneToOne: false
            referencedRelation: "bafi_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_elementary_collection_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_elementary_collection_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_elementary_collection_insurance_company_id_fkey"
            columns: ["insurance_company_id"]
            isOneToOne: false
            referencedRelation: "insurance_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_elementary_collection_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "policies"
            referencedColumns: ["id"]
          },
        ]
      }
      bafi_forms: {
        Row: {
          branch: string | null
          catalog_number: string | null
          client_id: string
          created_at: string
          domain: string | null
          form_date: string | null
          form_name: string | null
          form_type: string | null
          id: string
          insurance_company_id: string | null
          pages: number | null
          status: string
          updated_at: string
        }
        Insert: {
          branch?: string | null
          catalog_number?: string | null
          client_id: string
          created_at?: string
          domain?: string | null
          form_date?: string | null
          form_name?: string | null
          form_type?: string | null
          id?: string
          insurance_company_id?: string | null
          pages?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          branch?: string | null
          catalog_number?: string | null
          client_id?: string
          created_at?: string
          domain?: string | null
          form_date?: string | null
          form_name?: string | null
          form_type?: string | null
          id?: string
          insurance_company_id?: string | null
          pages?: number | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bafi_forms_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_forms_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_forms_insurance_company_id_fkey"
            columns: ["insurance_company_id"]
            isOneToOne: false
            referencedRelation: "insurance_companies"
            referencedColumns: ["id"]
          },
        ]
      }
      bafi_life_collection: {
        Row: {
          benefit_45: number | null
          benefit_47: number | null
          benefits: number | null
          client_id: string
          created_at: string
          disability: number | null
          employee_disability: number | null
          employee_misc: number | null
          employee_total: number | null
          employer_id: string | null
          employer_misc: number | null
          employer_total: number | null
          id: string
          last_deposit_amount: number | null
          last_deposit_date: string | null
          last_deposit_notes: string | null
          policy_id: string | null
          policy_number: string | null
          premium_month: string | null
          product_type: string | null
          report_type: string | null
          salary: number | null
          severance_pay: number | null
          total_pct: number | null
          total_to_pay: number | null
          updated_at: string
        }
        Insert: {
          benefit_45?: number | null
          benefit_47?: number | null
          benefits?: number | null
          client_id: string
          created_at?: string
          disability?: number | null
          employee_disability?: number | null
          employee_misc?: number | null
          employee_total?: number | null
          employer_id?: string | null
          employer_misc?: number | null
          employer_total?: number | null
          id?: string
          last_deposit_amount?: number | null
          last_deposit_date?: string | null
          last_deposit_notes?: string | null
          policy_id?: string | null
          policy_number?: string | null
          premium_month?: string | null
          product_type?: string | null
          report_type?: string | null
          salary?: number | null
          severance_pay?: number | null
          total_pct?: number | null
          total_to_pay?: number | null
          updated_at?: string
        }
        Update: {
          benefit_45?: number | null
          benefit_47?: number | null
          benefits?: number | null
          client_id?: string
          created_at?: string
          disability?: number | null
          employee_disability?: number | null
          employee_misc?: number | null
          employee_total?: number | null
          employer_id?: string | null
          employer_misc?: number | null
          employer_total?: number | null
          id?: string
          last_deposit_amount?: number | null
          last_deposit_date?: string | null
          last_deposit_notes?: string | null
          policy_id?: string | null
          policy_number?: string | null
          premium_month?: string | null
          product_type?: string | null
          report_type?: string | null
          salary?: number | null
          severance_pay?: number | null
          total_pct?: number | null
          total_to_pay?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bafi_life_collection_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_life_collection_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_life_collection_employer_id_fkey"
            columns: ["employer_id"]
            isOneToOne: false
            referencedRelation: "employers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bafi_life_collection_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "policies"
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
      claims: {
        Row: {
          amount: number | null
          claim_number: string | null
          claim_type: string | null
          client_id: string
          created_at: string
          id: string
          notes: string | null
          opened_at: string | null
          policy_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount?: number | null
          claim_number?: string | null
          claim_type?: string | null
          client_id: string
          created_at?: string
          id?: string
          notes?: string | null
          opened_at?: string | null
          policy_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number | null
          claim_number?: string | null
          claim_type?: string | null
          client_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          opened_at?: string | null
          policy_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "claims_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "policies"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address: string | null
          agency_group: string | null
          assigned_handler_id: string | null
          assigned_to: string
          bafi_file_number: string | null
          client_type: string | null
          created_at: string
          date_of_birth: string | null
          email: string | null
          full_name: string
          gender: string | null
          health_fund: string | null
          id: string
          id_issue_date: string | null
          id_number: string | null
          id_photo_url: string | null
          id_validated: boolean
          inquiry_type: string
          intake_completed_at: string | null
          intake_current_slot: string | null
          intake_state: string
          last_service_date: string | null
          notes: string | null
          passport_number: string | null
          phone: string
          pipeline_stage: string | null
          poa_doc_url: string | null
          poa_signed: boolean
          referring_party: string | null
          source_channel: string
          status: string
          updated_at: string
          workplace: string | null
        }
        Insert: {
          address?: string | null
          agency_group?: string | null
          assigned_handler_id?: string | null
          assigned_to: string
          bafi_file_number?: string | null
          client_type?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          full_name: string
          gender?: string | null
          health_fund?: string | null
          id?: string
          id_issue_date?: string | null
          id_number?: string | null
          id_photo_url?: string | null
          id_validated?: boolean
          inquiry_type: string
          intake_completed_at?: string | null
          intake_current_slot?: string | null
          intake_state?: string
          last_service_date?: string | null
          notes?: string | null
          passport_number?: string | null
          phone: string
          pipeline_stage?: string | null
          poa_doc_url?: string | null
          poa_signed?: boolean
          referring_party?: string | null
          source_channel: string
          status?: string
          updated_at?: string
          workplace?: string | null
        }
        Update: {
          address?: string | null
          agency_group?: string | null
          assigned_handler_id?: string | null
          assigned_to?: string
          bafi_file_number?: string | null
          client_type?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          full_name?: string
          gender?: string | null
          health_fund?: string | null
          id?: string
          id_issue_date?: string | null
          id_number?: string | null
          id_photo_url?: string | null
          id_validated?: boolean
          inquiry_type?: string
          intake_completed_at?: string | null
          intake_current_slot?: string | null
          intake_state?: string
          last_service_date?: string | null
          notes?: string | null
          passport_number?: string | null
          phone?: string
          pipeline_stage?: string | null
          poa_doc_url?: string | null
          poa_signed?: boolean
          referring_party?: string | null
          source_channel?: string
          status?: string
          updated_at?: string
          workplace?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_assigned_handler_id_fkey"
            columns: ["assigned_handler_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          client_id: string
          created_at: string
          email: string | null
          full_name: string
          id: string
          notes: string | null
          phone: string | null
          relation: string | null
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          notes?: string | null
          phone?: string | null
          relation?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          notes?: string | null
          phone?: string | null
          relation?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          bot_paused: boolean
          bot_paused_until: string | null
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
          bot_paused_until?: string | null
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
          bot_paused_until?: string | null
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
      employers: {
        Row: {
          address: string | null
          contact_phone: string | null
          created_at: string
          id: string
          name: string
          tax_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          name: string
          tax_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          name?: string
          tax_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      gmail_integrations: {
        Row: {
          access_token: string | null
          access_token_expires_at: string | null
          connected_at: string
          created_at: string
          email: string
          id: string
          is_active: boolean
          last_error: string | null
          last_synced_at: string | null
          last_unread_count: number | null
          refresh_token: string
          scope: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          access_token_expires_at?: string | null
          connected_at?: string
          created_at?: string
          email: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_synced_at?: string | null
          last_unread_count?: number | null
          refresh_token: string
          scope: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          access_token_expires_at?: string | null
          connected_at?: string
          created_at?: string
          email?: string
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_synced_at?: string | null
          last_unread_count?: number | null
          refresh_token?: string
          scope?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gmail_integrations_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      insurance_companies: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          short_code: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          short_code?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          short_code?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      meetings: {
        Row: {
          calendar_event_id: string | null
          client_confirmed: boolean
          client_id: string
          conversation_id: string | null
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
          timeless_meeting_id: string | null
          transcript: string | null
          type: string
          updated_at: string
        }
        Insert: {
          calendar_event_id?: string | null
          client_confirmed?: boolean
          client_id: string
          conversation_id?: string | null
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
          timeless_meeting_id?: string | null
          transcript?: string | null
          type: string
          updated_at?: string
        }
        Update: {
          calendar_event_id?: string | null
          client_confirmed?: boolean
          client_id?: string
          conversation_id?: string | null
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
          timeless_meeting_id?: string | null
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
          {
            foreignKeyName: "meetings_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
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
      notifications: {
        Row: {
          client_id: string | null
          created_at: string
          id: string
          is_read: boolean
          meeting_id: string | null
          message: string
          read_at: string | null
          reference_key: string | null
          severity: string
          task_id: string | null
          title: string
          type: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          meeting_id?: string | null
          message: string
          read_at?: string | null
          reference_key?: string | null
          severity?: string
          task_id?: string | null
          title: string
          type: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          meeting_id?: string | null
          message?: string
          read_at?: string | null
          reference_key?: string | null
          severity?: string
          task_id?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      policies: {
        Row: {
          balance_as_of: string | null
          client_id: string
          created_at: string
          end_date: string | null
          fund_balance: number | null
          fund_status: string | null
          fund_track: string | null
          id: string
          insurance_company_id: string | null
          managed_by: string | null
          opening_amount: number | null
          plan_name: string | null
          policy_number: string
          policy_type: string
          product_name: string | null
          product_number: string | null
          start_date: string | null
          status: string
          updated_at: string
        }
        Insert: {
          balance_as_of?: string | null
          client_id: string
          created_at?: string
          end_date?: string | null
          fund_balance?: number | null
          fund_status?: string | null
          fund_track?: string | null
          id?: string
          insurance_company_id?: string | null
          managed_by?: string | null
          opening_amount?: number | null
          plan_name?: string | null
          policy_number: string
          policy_type: string
          product_name?: string | null
          product_number?: string | null
          start_date?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          balance_as_of?: string | null
          client_id?: string
          created_at?: string
          end_date?: string | null
          fund_balance?: number | null
          fund_status?: string | null
          fund_track?: string | null
          id?: string
          insurance_company_id?: string | null
          managed_by?: string | null
          opening_amount?: number | null
          plan_name?: string | null
          policy_number?: string
          policy_type?: string
          product_name?: string | null
          product_number?: string | null
          start_date?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "policies_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policies_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "v_client_pipeline"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policies_insurance_company_id_fkey"
            columns: ["insurance_company_id"]
            isOneToOne: false
            referencedRelation: "insurance_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policies_managed_by_fkey"
            columns: ["managed_by"]
            isOneToOne: false
            referencedRelation: "staff"
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
      system_settings: {
        Row: {
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          key?: string
          updated_at?: string
          value?: string
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
      timeless_unmatched_meetings: {
        Row: {
          candidate_meeting_ids: string[] | null
          created_at: string
          host_email: string | null
          id: string
          participants: Json
          reason: string
          resolved_at: string | null
          resolved_to_meeting_id: string | null
          start_time: string
          timeless_meeting_id: string
        }
        Insert: {
          candidate_meeting_ids?: string[] | null
          created_at?: string
          host_email?: string | null
          id?: string
          participants: Json
          reason: string
          resolved_at?: string | null
          resolved_to_meeting_id?: string | null
          start_time: string
          timeless_meeting_id: string
        }
        Update: {
          candidate_meeting_ids?: string[] | null
          created_at?: string
          host_email?: string | null
          id?: string
          participants?: Json
          reason?: string
          resolved_at?: string | null
          resolved_to_meeting_id?: string | null
          start_time?: string
          timeless_meeting_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "timeless_unmatched_meetings_resolved_to_meeting_id_fkey"
            columns: ["resolved_to_meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_instances: {
        Row: {
          created_at: string
          green_api_instance_id: string | null
          green_api_token: string | null
          green_api_url: string | null
          id: string
          is_active: boolean
          is_connected: boolean | null
          label: string
          last_error: string | null
          last_synced_at: string | null
          last_unanswered_count: number | null
          phone_number: string | null
          role: string
          staff_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          green_api_instance_id?: string | null
          green_api_token?: string | null
          green_api_url?: string | null
          id?: string
          is_active?: boolean
          is_connected?: boolean | null
          label: string
          last_error?: string | null
          last_synced_at?: string | null
          last_unanswered_count?: number | null
          phone_number?: string | null
          role: string
          staff_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          green_api_instance_id?: string | null
          green_api_token?: string | null
          green_api_url?: string | null
          id?: string
          is_active?: boolean
          is_connected?: boolean | null
          label?: string
          last_error?: string | null
          last_synced_at?: string | null
          last_unanswered_count?: number | null
          phone_number?: string | null
          role?: string
          staff_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_instances_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
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
          intake_current_slot: string | null
          intake_state: string | null
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
          intake_current_slot?: string | null
          intake_state?: string | null
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
          intake_current_slot?: string | null
          intake_state?: string | null
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
