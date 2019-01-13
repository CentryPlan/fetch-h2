import { IncomingMessage } from "http";
import { constants as h2constants } from "http2";
import { Socket } from "net";

import { syncGuard } from "callguard";

import {
	FetchInit,
	SimpleSessionHttp1,
} from "./core";
import {
	FetchExtra,
	handleSignalAndTimeout,
	make100Error,
	makeAbortedError,
	makeIllegalRedirectError,
	makeRedirectionError,
	makeRedirectionMethodError,
	makeTimeoutError,
	setupFetch,
} from "./fetch-common";
import { GuardedHeaders } from "./headers";
import { Request } from "./request";
import { Response, StreamResponse } from "./response";
import { arrayify, isRedirectStatus, parseLocation } from "./utils";

const {
	// Responses, these are the same in HTTP/1.1 and HTTP/2
	HTTP2_HEADER_LOCATION: HTTP1_HEADER_LOCATION,
	HTTP2_HEADER_SET_COOKIE: HTTP1_HEADER_SET_COOKIE,
} = h2constants;


export async function fetchImpl(
	session: SimpleSessionHttp1,
	input: Request,
	init: Partial< FetchInit > = { },
	extra: FetchExtra
)
: Promise< Response >
{
	const {
		cleanup,
		contentDecoders,
		endStream,
		headersToSend,
		integrity,
		method,
		onTrailers,
		redirect,
		redirected,
		request,
		signal,
		signalPromise,
		timeoutAt,
		timeoutInfo,
		url,
	} = await setupFetch( session, input, init, extra );

	const doFetch = async ( ): Promise< Response > =>
	{
		const req = session.get( url );

		for ( const [ key, value ] of Object.entries( headersToSend ) )
		{
			if ( value != null )
				req.setHeader( key, value );
		}

		const response = new Promise< Response >( ( resolve, reject ) =>
		{
			const guard = syncGuard( reject, { catchAsync: true } );

			req.once( "error", reject );

			req.once( "aborted", guard( ( ) =>
			{
				reject( makeAbortedError( ) );
			} ) );

			req.once( "continue", guard( ( ) =>
			{
				reject( make100Error( ) );
			} ) );

			req.once( "information", guard( ( res: any ) =>
			{
				resolve( new Response(
					null, // No body
					{ status: res.statusCode }
				) );
			} ) );

			req.once( "timeout", guard( ( ) =>
			{
				reject( makeTimeoutError( ) );
				req.abort( );
			} ) );

			req.once( "upgrade", guard(
				(
					_res: IncomingMessage,
					_socket: Socket,
					_upgradeHead: Buffer
				) =>
				{
					reject( new Error( "Upgrade not implemented!" ) );
					req.abort( );
				} )
			);

			req.once( "response", guard( ( res: IncomingMessage ) =>
			{
				if ( signal && signal.aborted )
				{
					// No reason to continue, the request is aborted
					req.abort( );
					return;
				}

				const { headers, statusCode } = res;

				res.once( "end", guard( ( ) =>
				{
					if ( !onTrailers )
						return;

					try
					{
						const { trailers } = res;
						const headers = new GuardedHeaders( "response" );

						Object.keys( trailers ).forEach( key =>
						{
							if ( trailers[ key ] != null )
								headers.set( key, "" + trailers[ key ] );
						} );

						onTrailers( headers );
					}
					catch ( err )
					{
						// TODO: Implement #8
						// tslint:disable-next-line
						console.warn( "Trailer handling failed", err );
					}
				} ) );

				const location = parseLocation(
					headers[ HTTP1_HEADER_LOCATION ],
					url
				);

				const isRedirected = isRedirectStatus[ "" + statusCode ];

				if ( headers[ HTTP1_HEADER_SET_COOKIE ] )
				{
					const setCookies =
						arrayify( headers[ HTTP1_HEADER_SET_COOKIE ] );

					session.cookieJar.setCookies( setCookies, url );
				}

				delete headers[ "set-cookie" ];
				delete headers[ "set-cookie2" ];

				if ( isRedirected && !location )
					return reject( makeIllegalRedirectError( ) );

				if ( !isRedirected || redirect === "manual" )
					return resolve(
						new StreamResponse(
							contentDecoders,
							url,
							res,
							headers,
							redirect === "manual"
								? false
								: extra.redirected.length > 0,
							{
								status: res.statusCode,
								statusText: res.statusMessage,
							},
							1,
							integrity
						)
					);

				if ( redirect === "error" )
					return reject( makeRedirectionError( location ) );

				// redirect is 'follow'

				// We don't support re-sending a non-GET/HEAD request (as
				// we don't want to [can't, if its' streamed] re-send the
				// body). The concept is fundementally broken anyway...
				if ( !endStream )
					return reject(
						makeRedirectionMethodError( location, method )
					);

				if ( !location )
					return reject( makeIllegalRedirectError( ) );

				res.destroy( );
				resolve(
					fetchImpl(
						session,
						request.clone( location ),
						{ signal, onTrailers },
						{
							redirected: redirected.concat( url ),
							timeoutAt,
						}
					)
				);
			} ) );
		} );

		if ( endStream )
			req.end( );
		else
			await request.readable( )
			.then( readable =>
			{
				readable.pipe( req );
			} );

		return response;
	};

	return handleSignalAndTimeout(
		signalPromise,
		timeoutInfo,
		cleanup,
		doFetch
	);
}

export function fetch(
	session: SimpleSessionHttp1,
	input: Request,
	init?: Partial< FetchInit >
)
: Promise< Response >
{
	const timeoutAt = void 0;

	const extra = { timeoutAt, redirected: [ ] };

	return fetchImpl( session, input, init, extra );
}
