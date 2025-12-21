'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import IOSButton from '@/components/IOSButton'
import { IOSInputRow, IOSGroup } from '@/components/IOSComponents'

export default function Signup() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)
    const router = useRouter()

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError(null)

        const { error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: `${location.origin}/auth/callback`,
            },
        })

        if (error) {
            setError(error.message)
            setLoading(false)
        } else {
            setSuccess(true)
            setLoading(false)
        }
    }

    if (success) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[80vh] w-full max-w-md mx-auto p-4 text-center space-y-4">
                <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                </div>
                <h2 className="text-2xl font-bold text-ios-text">Check your email</h2>
                <p className="text-ios-text-secondary">We've sent you a confirmation link to <b>{email}</b>.</p>
                <div className="pt-8 w-full">
                    <Link href="/login">
                        <IOSButton variant="secondary">Back to Login</IOSButton>
                    </Link>
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col items-center justify-center min-h-[80vh] w-full max-w-md mx-auto p-4">
            <div className="w-full mb-10 text-center">
                <h1 className="text-[34px] font-bold text-ios-text tracking-tight">Join AutoReels</h1>
                <p className="text-ios-text-secondary mt-2">Create an account to start publishing</p>
            </div>

            <form onSubmit={handleSignup} className="w-full">
                <IOSGroup header="New Account">
                    <IOSInputRow
                        label="Email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@example.com"
                    />
                    <IOSInputRow
                        label="Password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="At least 6 chars"
                    />
                </IOSGroup>

                {error && (
                    <div className="mb-6 p-3 bg-red-50 dark:bg-red-900/20 text-ios-red text-sm rounded-xl text-center">
                        {error}
                    </div>
                )}

                <div className="space-y-4">
                    <IOSButton type="submit" disabled={loading} className='shadow-lg'>
                        {loading ? 'Creating Account...' : 'Sign Up'}
                    </IOSButton>

                    <Link href="/login" className="block text-center text-ios-blue text-[15px]">
                        Already have an account? Sign In
                    </Link>
                </div>
            </form>
        </div>
    )
}
