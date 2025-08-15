use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("5JJV9foQ27twoVKKqcKhm1tKZhQQXgLCLykrde37rzaK");

#[program]
pub mod voltnet_lottery {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        ticket_price_lamports: u64,
        platform_fee_bps: u16,
        rake_bps: u16,
        withdrawal_fee_bps: u16,
        winner_bps: u16,
        rollover_bps: u16,
    ) -> Result<()> {
        require!(winner_bps as u32 + rollover_bps as u32 == 10_000, VoltError::BadBps);

        let state = &mut ctx.accounts.state;
        state.admin = *ctx.accounts.admin.key;
        state.treasury = *ctx.accounts.treasury.key;
        state.vault = ctx.accounts.vault.key();
        state.ticket_price_lamports = ticket_price_lamports;
        state.platform_fee_bps = platform_fee_bps;
        state.rake_bps = rake_bps;
        state.withdrawal_fee_bps = withdrawal_fee_bps;
        state.winner_bps = winner_bps;
        state.rollover_bps = rollover_bps;
        state.epoch = 0;
        state.draw_open = true;
        Ok(())
    }

    pub fn buy_tickets(ctx: Context<BuyTickets>, count: u64) -> Result<()> {
        require!(count > 0, VoltError::BadAmount);
        let state = &ctx.accounts.state;
        require!(state.draw_open, VoltError::DrawClosed);

        let total = state.ticket_price_lamports.checked_mul(count).ok_or(VoltError::Overflow)?;
        let fee = total * state.platform_fee_bps as u64 / 10_000;
        let to_vault = total.checked_sub(fee).ok_or(VoltError::Overflow)?;

        // user -> treasury (platform fee)
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer { from: ctx.accounts.user.to_account_info(), to: ctx.accounts.treasury.to_account_info() }
            ),
            fee,
        )?;

        // user -> vault (jackpot share)
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer { from: ctx.accounts.user.to_account_info(), to: ctx.accounts.vault.to_account_info() }
            ),
            to_vault,
        )?;

        let ut = &mut ctx.accounts.user_tickets;
        ut.user = *ctx.accounts.user.key;
        ut.epoch = state.epoch;
        ut.count = ut.count.saturating_add(count);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: treasury is a system account
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init,
        seeds = [b"state"],
        bump,
        payer = admin,
        space = 8 + LotteryState::SIZE
    )]
    pub state: Account<'info, LotteryState>,
    #[account(
        init,
        seeds = [b"vault", state.key().as_ref()],
        bump,
        payer = admin,
        space = 8 // lamports-only PDA
    )]
    /// CHECK: vault holds only lamports
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyTickets<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"state"], bump)]
    pub state: Account<'info, LotteryState>,
    #[account(mut, seeds = [b"vault", state.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"user_tickets", user.key().as_ref(), &state.epoch.to_le_bytes()],
        bump,
        space = 8 + UserTickets::SIZE
    )]
    pub user_tickets: Account<'info, UserTickets>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct LotteryState {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub vault: Pubkey,
    pub ticket_price_lamports: u64,
    pub platform_fee_bps: u16,
    pub rake_bps: u16,
    pub withdrawal_fee_bps: u16,
    pub winner_bps: u16,
    pub rollover_bps: u16,
    pub epoch: u64,
    pub draw_open: bool,
}
impl LotteryState {
    pub const SIZE: usize = 32 + 32 + 32 + 8 + 2 + 2 + 2 + 2 + 2 + 8 + 1;
}

#[account]
pub struct UserTickets {
    pub user: Pubkey,
    pub epoch: u64,
    pub count: u64,
}
impl UserTickets {
    pub const SIZE: usize = 32 + 8 + 8;
}

#[error_code]
pub enum VoltError {
    #[msg("invalid bps")] BadBps,
    #[msg("overflow")] Overflow,
    #[msg("bad amount")] BadAmount,
    #[msg("draw closed")] DrawClosed,
}
