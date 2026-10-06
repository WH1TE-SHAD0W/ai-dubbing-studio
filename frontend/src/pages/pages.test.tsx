import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../api/client'
import { currentHost } from '../auth/auth'
import { save } from '../lib/storage'
import { JoinPage } from './Join'
import { SignInPage } from './SignIn'

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function renderAt(path: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={element} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('SignInPage', () => {
  it('signs in through the backend and goes to create-session', async () => {
    const signIn = vi.spyOn(api, 'signIn').mockResolvedValue({ name: 'Dr. Test' })
    const user = userEvent.setup()
    renderAt('/signin', <SignInPage />)
    await user.type(screen.getByLabelText('Email'), 'host@example.test')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByTestId('where')).toHaveTextContent('/sessions/new')
    expect(signIn).toHaveBeenCalledWith('host@example.test', 'correct horse')
    expect(currentHost()?.name).toBe('Dr. Test')
  })

  it('shows an error for wrong credentials, stays signed out, and allows another try', async () => {
    vi.spyOn(api, 'signIn').mockRejectedValue(new ApiError(401, 'Email or password is incorrect.'))
    const user = userEvent.setup()
    renderAt('/signin', <SignInPage />)
    await user.type(screen.getByLabelText('Email'), 'host@example.test')
    await user.type(screen.getByLabelText('Password'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect/i)
    expect(currentHost()).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('explains rate limiting and an unreachable backend', async () => {
    const signIn = vi.spyOn(api, 'signIn').mockRejectedValue(new ApiError(429, ''))
    const user = userEvent.setup()
    renderAt('/signin', <SignInPage />)
    await user.type(screen.getByLabelText('Email'), 'a@b.c')
    await user.type(screen.getByLabelText('Password'), 'x')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many attempts/i)

    signIn.mockRejectedValue(new ApiError(0, 'Network error'))
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/can’t reach the backend/i))
  })

  it('skips the form when already signed in', () => {
    save('ads.host', { name: 'Dr. Test' })
    renderAt('/signin', <SignInPage />)
    expect(screen.getByTestId('where')).toHaveTextContent('/sessions/new')
  })

  it('explains that password reset is unavailable', async () => {
    const user = userEvent.setup()
    renderAt('/signin', <SignInPage />)
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.getByRole('status')).toHaveTextContent(/administrator/i)
  })
})

describe('JoinPage', () => {
  it('formats the code as you type and keeps Join disabled until it is complete', async () => {
    const user = userEvent.setup()
    renderAt('/join', <JoinPage />)
    const input = screen.getByLabelText('Room code')
    const join = screen.getByRole('button', { name: 'Join as guest' })
    await user.type(input, 'kx74')
    expect(input).toHaveValue('KX7-4')
    expect(join).toBeDisabled()
    await user.type(input, 'm2')
    expect(input).toHaveValue('KX7-4M2')
    expect(join).toBeEnabled()
  })

  it('looks the code up and continues to the audio check', async () => {
    const info = { title: 'T', speakerName: 'S', sourceLang: 'en', languages: ['sk'] }
    const lookup = vi.spyOn(api, 'lookupJoin').mockResolvedValue(info)
    const user = userEvent.setup()
    renderAt('/join', <JoinPage />)
    await user.type(screen.getByLabelText('Room code'), 'kx74m2')
    await user.click(screen.getByRole('button', { name: 'Join as guest' }))
    expect(lookup).toHaveBeenCalledWith('KX74M2')
    expect(await screen.findByTestId('where')).toHaveTextContent('/listen/KX74M2/setup')
  })

  it('says so when no live session has the code', async () => {
    vi.spyOn(api, 'lookupJoin').mockRejectedValue(new ApiError(404, ''))
    const user = userEvent.setup()
    renderAt('/join', <JoinPage />)
    await user.type(screen.getByLabelText('Room code'), 'kx74m2')
    await user.click(screen.getByRole('button', { name: 'Join as guest' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/no live session/i)
  })

  it('says so when the backend is unreachable', async () => {
    vi.spyOn(api, 'lookupJoin').mockRejectedValue(new ApiError(0, 'Network error'))
    const user = userEvent.setup()
    renderAt('/join', <JoinPage />)
    await user.type(screen.getByLabelText('Room code'), 'kx74m2')
    await user.click(screen.getByRole('button', { name: 'Join as guest' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/can’t reach the backend/i))
  })
})
